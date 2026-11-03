import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import type { Logger } from '../logger.js';
import type { FluxerPlatform } from './platform.js';
import { VoiceUnsupportedError } from './voice.js';

/**
 * Sprachverbindungen für Bots auf Fluxer (Audio über LiveKit).
 *
 * Ablauf (wie @fluxerjs/voice, aber auf unserer Plattform-Schicht):
 *  1. op 4 (Voice State Update) mit guild_id, channel_id und mutation_id senden
 *  2. Gateway antwortet mit VOICE_SERVER_UPDATE (endpoint + token, ~600 s gültig, connection_id)
 *     bzw. VOICE_STATE_ACK (bei Ablehnung mit error_code)
 *  3. Mit endpoint/token verbindet LiveKitRtcConnection (@fluxerjs/voice) den LiveKit-Raum
 *  4. play() nimmt WebM/Opus (URL, Datei oder Stream) und veröffentlicht einen Audio-Track
 *
 * EXPERIMENTELL: gegen eine echte Fluxer-Instanz noch nicht getestet (siehe README).
 */

/** Minimale Sicht auf LiveKitRtcConnection aus @fluxerjs/voice. */
export interface RtcConnection extends EventEmitter {
  readonly playing: boolean;
  isConnected(): boolean;
  connect(server: unknown, state: unknown): Promise<void>;
  play(source: string | NodeJS.ReadableStream): Promise<void>;
  setVolume(percent: number): void;
  getVolume(): number;
  stop(): void;
  destroy(): void;
}

export interface VoiceSession {
  guildId: string;
  channelId: string;
  connectionId: string | null;
  conn: RtcConnection;
}

interface Pending {
  guildId: string;
  channelId: string;
  mutationId: string;
  resolve: (s: VoiceSession) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

type RtcFactory = (guildId: string, channelId: string, botUserId: string) => Promise<RtcConnection>;

/** Lädt @fluxerjs/voice erst bei Bedarf (natives LiveKit-Modul). */
const defaultFactory: RtcFactory = async (guildId, channelId, botUserId) => {
  let mod: { LiveKitRtcConnection: new (client: unknown, channel: unknown, userId: string) => RtcConnection };
  try {
    mod = (await import('@fluxerjs/voice')) as unknown as typeof mod;
  } catch (err) {
    throw new VoiceUnsupportedError(`@fluxerjs/voice/LiveKit konnte nicht geladen werden: ${(err as Error).message}`);
  }
  // Die LiveKit-Verbindung nutzt Client/Kanal nur für guildId/id – ein schlanker Stub genügt.
  const clientStub = new EventEmitter();
  return new mod.LiveKitRtcConnection(clientStub, { id: channelId, guildId }, botUserId);
};

export class VoiceService extends EventEmitter {
  private readonly sessions = new Map<string, VoiceSession>();
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly platform: FluxerPlatform,
    private readonly log: Logger,
    private readonly factory: RtcFactory = defaultFactory,
    private readonly timeoutMs = 20_000,
  ) {
    super();
    platform.on('VOICE_SERVER_UPDATE', (d: { guild_id?: string; channel_id?: string; endpoint?: string | null; token?: string; connection_id?: string | null }) => {
      void this.onServerUpdate(d);
    });
    platform.on('VOICE_STATE_ACK', (d: { mutation_id?: string; status?: string; error_code?: string; connection_id?: string }) => this.onAck(d));
    platform.on('VOICE_STATE_UPDATE', (d: { guild_id?: string; user_id: string; channel_id: string | null }) => {
      // Bot wurde getrennt/verschoben (z. B. von einem Mod)
      if (!d.guild_id || d.user_id !== platform.user?.id) return;
      const s = this.sessions.get(d.guild_id);
      if (s && !d.channel_id) this.cleanup(d.guild_id, 'kicked');
      else if (s && d.channel_id && d.channel_id !== s.channelId) s.channelId = d.channel_id;
    });
  }

  get(guildId: string): VoiceSession | undefined {
    return this.sessions.get(guildId);
  }

  /** Betritt einen Sprachkanal (oder wechselt). Wirft VoiceUnsupportedError bei Problemen. */
  async join(guildId: string, channelId: string): Promise<VoiceSession> {
    const existing = this.sessions.get(guildId);
    if (existing?.channelId === channelId && existing.conn.isConnected()) return existing;
    if (existing) this.leave(guildId);
    if (!this.platform.user) throw new VoiceUnsupportedError('Bot ist nicht verbunden.');
    if (this.pending.has(guildId)) throw new VoiceUnsupportedError('Verbindungsaufbau läuft bereits.');
    return new Promise<VoiceSession>((resolve, reject) => {
      const mutationId = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(guildId);
        reject(new VoiceUnsupportedError('Keine Antwort vom Sprachserver (VOICE_SERVER_UPDATE). Ist Sprache auf der Instanz aktiviert und hat der Bot das Recht „Verbinden“?'));
      }, this.timeoutMs);
      timer.unref();
      this.pending.set(guildId, { guildId, channelId, mutationId, resolve, reject, timer });
      this.platform.gateway?.send(0, {
        op: 4,
        d: { guild_id: guildId, channel_id: channelId, self_mute: false, self_deaf: true, mutation_id: mutationId },
      });
    });
  }

  private onAck(d: { mutation_id?: string; status?: string; error_code?: string; connection_id?: string }): void {
    if (!d.mutation_id) return;
    const p = [...this.pending.values()].find((x) => x.mutationId === d.mutation_id);
    if (!p) return;
    if (d.status === 'rejected' || (typeof d.error_code === 'string' && d.error_code)) {
      clearTimeout(p.timer);
      this.pending.delete(p.guildId);
      p.reject(new VoiceUnsupportedError(`Sprachkanal abgelehnt (${d.error_code ?? 'rejected'}).`));
    }
  }

  private async onServerUpdate(d: { guild_id?: string; channel_id?: string; endpoint?: string | null; token?: string; connection_id?: string | null }): Promise<void> {
    const guildId = d.guild_id;
    if (!guildId) return;
    const p = this.pending.get(guildId);
    const session = this.sessions.get(guildId);
    if (!p && !session) return;
    if (!d.endpoint || !d.token) {
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(guildId);
        p.reject(new VoiceUnsupportedError('Der Sprachserver hat keinen Endpunkt geliefert.'));
      } else this.cleanup(guildId, 'no-endpoint');
      return;
    }
    const channelId = p?.channelId ?? d.channel_id ?? session!.channelId;
    try {
      // Server-Wechsel einer bestehenden Verbindung: neu verbinden
      session?.conn.destroy();
      const conn = await this.factory(guildId, channelId, this.platform.user!.id);
      // Ein 'error' ohne Listener würde den Prozess beenden – daher immer abfangen.
      conn.on('error', (err: Error) => {
        this.log.warn({ err, guildId }, 'Fehler in der Sprachverbindung');
        this.emit('error', guildId, err);
      });
      conn.on('disconnect', () => {
        if (this.sessions.get(guildId)?.conn === conn) this.cleanup(guildId, 'disconnect');
      });
      await conn.connect(
        { token: d.token, endpoint: d.endpoint, guild_id: guildId, channel_id: channelId, connection_id: d.connection_id ?? null },
        { guild_id: guildId, channel_id: channelId, user_id: this.platform.user!.id, session_id: '', mute: false, deaf: false, self_mute: false, self_deaf: true },
      );
      const s: VoiceSession = { guildId, channelId, connectionId: d.connection_id ?? null, conn };
      this.sessions.set(guildId, s);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(guildId);
        p.resolve(s);
      }
      this.log.info({ guildId, channelId }, 'Sprachkanal verbunden');
    } catch (err) {
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(guildId);
        p.reject(err instanceof VoiceUnsupportedError ? err : new VoiceUnsupportedError((err as Error).message));
      }
    }
  }

  /** Sprachkanal verlassen. */
  leave(guildId: string): void {
    const s = this.sessions.get(guildId);
    this.cleanup(guildId, 'leave');
    this.platform.gateway?.send(0, {
      op: 4,
      d: { guild_id: guildId, channel_id: null, self_mute: false, self_deaf: false, ...(s?.connectionId ? { connection_id: s.connectionId } : {}) },
    });
  }

  private cleanup(guildId: string, reason: string): void {
    const s = this.sessions.get(guildId);
    if (!s) return;
    this.sessions.delete(guildId);
    try {
      s.conn.destroy();
    } catch {
      /* bereits zerstört */
    }
    this.emit('disconnect', guildId, reason);
  }

  /** Spielt eine Quelle ab und wartet, bis sie zu Ende ist (oder gestoppt wurde). */
  async playAndWait(guildId: string, source: string | Readable, signal?: AbortSignal): Promise<void> {
    const s = this.sessions.get(guildId);
    if (!s) throw new VoiceUnsupportedError('Nicht mit einem Sprachkanal verbunden.');
    await s.conn.play(source);
    // Kein "end"-Event in @fluxerjs/voice → Status abfragen.
    await new Promise<void>((resolve) => {
      let started = false;
      const iv = setInterval(() => {
        const cur = this.sessions.get(guildId);
        if (!cur || cur.conn !== s.conn || signal?.aborted) {
          clearInterval(iv);
          return resolve();
        }
        if (s.conn.playing) started = true;
        else if (started || Date.now() - t0 > 15_000) {
          clearInterval(iv);
          resolve();
        }
      }, 500);
      const t0 = Date.now();
    });
  }

  destroyAll(): void {
    for (const id of [...this.sessions.keys()]) this.leave(id);
  }
}
