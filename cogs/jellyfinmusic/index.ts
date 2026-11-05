import { spawn, execFile } from 'node:child_process';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';
import {
  defineCog,
  embed,
  fetchJson,
  humanizeSeconds,
  NUMBER_EMOJIS,
  OptionType,
  pagify,
  UserError,
  type Cog,
  type CommandContext,
} from '@bot/sdk';

const run = promisify(execFile);

export interface Track {
  title: string;
  source: 'youtube' | 'jellyfin' | 'url';
  /** YouTube-URL, Jellyfin-Item-ID oder direkte URL. */
  ref: string;
  duration: number | null;
  requester: string;
}

export type LoopMode = 'off' | 'track' | 'queue';

/** Schnittstelle für den Cog "audio" (Phase 5): Playlists, Repeat, Shuffle bauen darauf auf. */
export interface MusicApi {
  enqueue(guildId: string, voiceChannelId: string, textChannelId: string, tracks: Track[]): Promise<number>;
  queue(guildId: string): Track[];
  current(guildId: string): Track | null;
  history(guildId: string): Track[];
  loop(guildId: string): LoopMode;
  setLoop(guildId: string, mode: LoopMode): void;
  shuffle(guildId: string): void;
  /** Titel in der Warteschlange verschieben (1-basiert). */
  move(guildId: string, from: number, to: number): Track | null;
  clear(guildId: string): number;
  skip(guildId: string): void;
  stop(guildId: string): void;
  resolveQuery(query: string, requester: string): Promise<Track[]>;
  /** Regel für Befehle (DJ-Rolle, Limits, Jukebox …). Liefert eine Funktion zum Entfernen. */
  addGuard(guard: MusicGuard): () => void;
}

export type MusicAction = 'enqueue' | 'skip' | 'stop' | 'remove' | 'volume' | 'control';
export interface GuardInfo {
  guildId: string;
  userId: string;
  action: MusicAction;
  tracks?: Track[];
  queueLength: number;
}
/**
 * Rückgabe: null = erlaubt, Text = verweigert (Text wird angezeigt),
 * 'vote' = (nur bei skip) Abstimmung der Zuhörer statt direktem Überspringen.
 */
export type MusicGuard = (info: GuardInfo) => Promise<string | 'vote' | null> | string | 'vote' | null;

/** Jellyfin-Universal-Stream, serverseitig nach WebM/Opus transkodiert (Annahme: Jellyfin 10.8+). */
export function jellyfinStreamUrl(base: string, itemId: string, apiKey: string, userId?: string): string {
  const q = new URLSearchParams({
    api_key: apiKey,
    Container: 'webm',
    AudioCodec: 'opus',
    TranscodingContainer: 'webm',
    TranscodingProtocol: 'http',
    MaxStreamingBitrate: '192000',
    DeviceId: 'fluxer-redbot',
  });
  if (userId) q.set('UserId', userId);
  return `${base.replace(/\/+$/, '')}/Audio/${encodeURIComponent(itemId)}/universal?${q}`;
}

export const isYoutubeUrl = (s: string) => /^https?:\/\/(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//i.test(s.trim());

export function formatDuration(sec: number | null): string {
  if (!sec) return '?:??';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

interface Player {
  guildId: string;
  voiceChannelId: string;
  textChannelId: string;
  queue: Track[];
  current: Track | null;
  loop: LoopMode;
  running: boolean;
  skipCtl: AbortController | null;
  child: ReturnType<typeof spawn> | null;
  idleTimer: NodeJS.Timeout | null;
  history: Track[];
  votes: Set<string>;
}

export default defineCog({
  setup(cog: Cog) {
    cog.config.registerGuild({ volume: 100, announce: true, idleLeave: 120 });
    const env = process.env;
    const ytdlp = env.YTDLP_PATH || 'yt-dlp';
    const jfUrl = (env.JELLYFIN_URL || 'https://jellyfin.mrcoolgamer.de').replace(/\/+$/, '');
    const jfKey = env.JELLYFIN_API_KEY?.trim();
    const jfUser = env.JELLYFIN_USER_ID?.trim();
    const players = new Map<string, Player>();
    const p = () => cog.platform;

    // ------------------------------------------------------------------ Quellen
    async function youtubeSearch(query: string, limit = 5): Promise<Array<{ id: string; title: string; duration: number | null }>> {
      const { stdout } = await run(ytdlp, [`ytsearch${limit}:${query}`, '--flat-playlist', '--no-warnings', '--print', '%(id)s\t%(title)s\t%(duration)s'], { timeout: 30_000, maxBuffer: 5_000_000 }).catch((err: { code?: string }) => {
        throw new UserError(err.code === 'ENOENT' ? cog.t('noYtdlp') : cog.t('ytFailed'));
      });
      return stdout
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          const [id, title, dur] = l.split('\t');
          return { id: id!, title: title ?? id!, duration: dur && dur !== 'NA' ? Number(dur) : null };
        });
    }

    async function youtubeInfo(url: string): Promise<Array<{ url: string; title: string; duration: number | null }>> {
      const { stdout } = await run(ytdlp, [url, '--flat-playlist', '--no-warnings', '--playlist-end', '100', '--print', '%(webpage_url,url)s\t%(title)s\t%(duration)s'], { timeout: 60_000, maxBuffer: 10_000_000 }).catch((err: { code?: string }) => {
        throw new UserError(err.code === 'ENOENT' ? cog.t('noYtdlp') : cog.t('ytFailed'));
      });
      return stdout
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          const [u, title, dur] = l.split('\t');
          return { url: u!, title: title ?? u!, duration: dur && dur !== 'NA' ? Number(dur) : null };
        });
    }

    interface JfItem {
      Id: string;
      Name: string;
      Type: string;
      RunTimeTicks?: number;
      AlbumArtist?: string;
      Artists?: string[];
    }
    async function jellyfin<T>(path: string, params: Record<string, string>): Promise<T> {
      if (!jfKey) throw new UserError(cog.t('noJellyfin'));
      const q = new URLSearchParams(params);
      if (jfUser) q.set('UserId', jfUser);
      return fetchJson<T>(`${jfUrl}${path}?${q}`, { headers: { 'X-Emby-Token': jfKey }, signal: cog.signal }).catch(() => {
        throw new UserError(cog.t('jellyfinDown'));
      });
    }
    const jfTrack = (i: JfItem, requester: string): Track => ({
      title: `${(i.Artists?.[0] ?? i.AlbumArtist) ? `${i.Artists?.[0] ?? i.AlbumArtist} – ` : ''}${i.Name}`,
      source: 'jellyfin',
      ref: i.Id,
      duration: i.RunTimeTicks ? Math.round(i.RunTimeTicks / 1e7) : null,
      requester,
    });
    async function jellyfinSearch(term: string): Promise<JfItem[]> {
      const res = await jellyfin<{ Items: JfItem[] }>('/Items', {
        searchTerm: term,
        IncludeItemTypes: 'Audio,MusicAlbum,Playlist',
        Recursive: 'true',
        Limit: '10',
        Fields: 'RunTimeTicks,AlbumArtist,Artists',
      });
      return res.Items ?? [];
    }
    async function jellyfinTracks(item: JfItem, requester: string): Promise<Track[]> {
      if (item.Type === 'Audio') return [jfTrack(item, requester)];
      const res = await jellyfin<{ Items: JfItem[] }>('/Items', {
        ParentId: item.Id,
        IncludeItemTypes: 'Audio',
        Recursive: 'true',
        SortBy: 'ParentIndexNumber,IndexNumber,SortName',
        Fields: 'RunTimeTicks,AlbumArtist,Artists',
        Limit: '200',
      });
      return (res.Items ?? []).map((i) => jfTrack(i, requester));
    }

    /** Eingabe → Tracks: YouTube-Link/Playlist, Jellyfin ("jf: …") oder YouTube-Suche (erster Treffer). */
    async function resolveQuery(query: string, requester: string): Promise<Track[]> {
      const q = query.trim();
      const jf = /^(?:jf|jellyfin)\s*:?\s+(.+)$/i.exec(q);
      if (jf) {
        const items = await jellyfinSearch(jf[1]!);
        if (!items.length) throw new UserError(cog.t('noHits'));
        return jellyfinTracks(items[0]!, requester);
      }
      if (isYoutubeUrl(q)) {
        return (await youtubeInfo(q)).map((v) => ({ title: v.title, source: 'youtube' as const, ref: v.url, duration: v.duration, requester }));
      }
      if (/^https?:\/\//i.test(q)) return [{ title: q, source: 'url', ref: q, duration: null, requester }];
      const hits = await youtubeSearch(q, 1);
      if (!hits.length) throw new UserError(cog.t('noHits'));
      return [{ title: hits[0]!.title, source: 'youtube', ref: `https://www.youtube.com/watch?v=${hits[0]!.id}`, duration: hits[0]!.duration, requester }];
    }

    /** Liefert eine WebM/Opus-Quelle für die LiveKit-Wiedergabe. */
    function openSource(pl: Player, t: Track): string | Readable {
      if (t.source === 'jellyfin') return jellyfinStreamUrl(jfUrl, t.ref, jfKey ?? '', jfUser);
      if (t.source === 'url') return t.ref;
      // YouTube: Audio direkt als WebM/Opus aus yt-dlp streamen (kein ffmpeg nötig)
      const child = spawn(ytdlp, ['-f', 'bestaudio[ext=webm][acodec=opus]/bestaudio[acodec=opus]', '-o', '-', '--no-playlist', '--quiet', '--no-warnings', '--', t.ref], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      child.on('error', (err) => cog.log.warn({ err }, 'yt-dlp konnte nicht gestartet werden'));
      pl.child = child;
      return child.stdout!;
    }

    // ------------------------------------------------------------------ Player
    const getPlayer = (guildId: string) => players.get(guildId);
    const announce = async (pl: Player, text: string) => {
      if (!cog.config.guild(pl.guildId).get<boolean>('announce')) return;
      await cog.bot.send(pl.textChannelId, { content: text, allowed_mentions: { parse: [] } }, pl.guildId).catch(() => undefined);
    };
    const killChild = (pl: Player) => {
      pl.child?.kill('SIGKILL');
      pl.child = null;
    };

    function scheduleIdleLeave(pl: Player): void {
      if (pl.idleTimer) clearTimeout(pl.idleTimer);
      const secs = cog.config.guild(pl.guildId).get<number>('idleLeave');
      pl.idleTimer = setTimeout(() => {
        if (!pl.running && !pl.queue.length) destroy(pl.guildId);
      }, secs * 1000);
      pl.idleTimer.unref();
    }

    async function runLoop(pl: Player): Promise<void> {
      if (pl.running) return;
      pl.running = true;
      if (pl.idleTimer) clearTimeout(pl.idleTimer);
      try {
        const session = await cog.bot.voice.join(pl.guildId, pl.voiceChannelId);
        session.conn.setVolume(cog.config.guild(pl.guildId).get<number>('volume'));
        while (pl.queue.length && players.get(pl.guildId) === pl) {
          const track = pl.queue.shift()!;
          pl.current = track;
          pl.skipCtl = new AbortController();
          await announce(pl, cog.tg(pl.guildId, 'nowPlaying', { title: track.title, duration: formatDuration(track.duration), user: `<@${track.requester}>` }));
          try {
            await cog.bot.voice.playAndWait(pl.guildId, openSource(pl, track), pl.skipCtl.signal);
          } catch (err) {
            await announce(pl, cog.tg(pl.guildId, 'trackFailed', { title: track.title, reason: (err as Error).message }));
          } finally {
            killChild(pl);
          }
          pl.history.unshift(track);
          pl.history.length = Math.min(pl.history.length, 20);
          pl.votes.clear();
          if (pl.loop === 'track' && !pl.skipCtl.signal.aborted) pl.queue.unshift(track);
          else if (pl.loop === 'queue') pl.queue.push(track);
        }
      } catch (err) {
        await announce(pl, `❌ ${(err as Error).message}`);
        pl.queue = [];
      } finally {
        pl.current = null;
        pl.running = false;
        if (players.get(pl.guildId) === pl) scheduleIdleLeave(pl);
      }
    }

    function destroy(guildId: string): void {
      const pl = players.get(guildId);
      if (!pl) return;
      players.delete(guildId);
      pl.queue = [];
      pl.skipCtl?.abort();
      killChild(pl);
      if (pl.idleTimer) clearTimeout(pl.idleTimer);
      cog.bot.voice.leave(guildId);
    }

    async function enqueue(guildId: string, voiceChannelId: string, textChannelId: string, tracks: Track[]): Promise<number> {
      let pl = players.get(guildId);
      if (!pl) {
        pl = { guildId, voiceChannelId, textChannelId, queue: [], current: null, loop: 'off', running: false, skipCtl: null, child: null, idleTimer: null, history: [], votes: new Set() };
        players.set(guildId, pl);
      }
      pl.textChannelId = textChannelId;
      pl.queue.push(...tracks);
      void runLoop(pl);
      return pl.queue.length;
    }

    const guards = new Set<MusicGuard>();
    /** Alle Regeln prüfen; der erste Einwand gewinnt. */
    async function checkGuards(info: GuardInfo): Promise<string | 'vote' | null> {
      let vote = false;
      for (const guard of guards) {
        const r = await guard(info);
        if (r === 'vote') vote = true;
        else if (r) return r;
      }
      return vote ? 'vote' : null;
    }

    const api: MusicApi = {
      enqueue,
      queue: (g) => [...(players.get(g)?.queue ?? [])],
      current: (g) => players.get(g)?.current ?? null,
      history: (g) => [...(players.get(g)?.history ?? [])],
      loop: (g) => players.get(g)?.loop ?? 'off',
      move: (g, from, to) => {
        const pl = players.get(g);
        if (!pl || from < 1 || from > pl.queue.length) return null;
        const [t] = pl.queue.splice(from - 1, 1);
        pl.queue.splice(Math.max(0, Math.min(pl.queue.length, to - 1)), 0, t!);
        return t!;
      },
      clear: (g) => {
        const pl = players.get(g);
        const n = pl?.queue.length ?? 0;
        if (pl) pl.queue = [];
        return n;
      },
      addGuard: (guard) => {
        guards.add(guard);
        return () => guards.delete(guard);
      },
      setLoop: (g, mode) => {
        const pl = players.get(g);
        if (pl) pl.loop = mode;
      },
      shuffle: (g) => {
        const pl = players.get(g);
        if (!pl) return;
        for (let i = pl.queue.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [pl.queue[i], pl.queue[j]] = [pl.queue[j]!, pl.queue[i]!];
        }
      },
      skip: (g) => {
        const pl = players.get(g);
        if (!pl) return;
        pl.skipCtl?.abort();
        killChild(pl);
        cog.bot.voice.get(g)?.conn.stop();
      },
      stop: destroy,
      resolveQuery,
    };
    cog.expose(api);

    // Allein im Kanal → nach Wartezeit verlassen
    cog.on('VOICE_STATE_UPDATE', (vs: { guild_id?: string }) => {
      const g = vs.guild_id;
      const pl = g ? players.get(g) : undefined;
      if (!g || !pl) return;
      const guild = p().getGuild(g);
      const humans = [...(guild?.voiceStates.values() ?? [])].filter(
        (s) => s.channel_id === pl.voiceChannelId && s.user_id !== p().user?.id && !(guild?.members.get(s.user_id)?.user as { bot?: boolean } | undefined)?.bot,
      );
      if (!humans.length) {
        if (pl.idleTimer) clearTimeout(pl.idleTimer);
        pl.idleTimer = setTimeout(() => destroy(g), cog.config.guild(g).get<number>('idleLeave') * 1000);
        pl.idleTimer.unref();
      } else if (pl.running && pl.idleTimer) {
        clearTimeout(pl.idleTimer);
        pl.idleTimer = null;
      }
    });
    // Bot wurde getrennt (z. B. von einem Mod) → Player aufräumen
    const onVoiceDisconnect = (guildId: string, reason: string) => {
      if (reason !== 'leave' && players.has(guildId)) {
        const pl = players.get(guildId)!;
        players.delete(guildId);
        pl.skipCtl?.abort();
        killChild(pl);
      }
    };
    cog.bot.voice.on('disconnect', onVoiceDisconnect);
    cog.onUnload(() => {
      cog.bot.voice.off('disconnect', onVoiceDisconnect);
      for (const g of [...players.keys()]) destroy(g);
    });

    // ------------------------------------------------------------------ Befehle
    const userVoice = (ctx: CommandContext): string => {
      const vc = p().getVoiceState(ctx.guildId!, ctx.author.id)?.channel_id;
      if (!vc) throw new UserError(ctx.t('joinVoice'));
      const pl = players.get(ctx.guildId!);
      if (pl && pl.voiceChannelId !== vc && pl.running) throw new UserError(ctx.t('otherChannel', { channel: `<#${pl.voiceChannelId}>` }));
      return vc;
    };
    const requirePlayer = (ctx: CommandContext): Player => {
      const pl = players.get(ctx.guildId!);
      if (!pl) throw new UserError(ctx.t('nothingPlaying'));
      return pl;
    };
    const voicePerms = { level: 'everyone', bot: ['Connect', 'Speak'] } as const;

    /** Regeln anderer Cogs (z. B. audio) prüfen; wirft bei Verweigerung. */
    const guard = async (ctx: CommandContext, action: MusicAction, tracks?: Track[]): Promise<'vote' | null> => {
      const r = await checkGuards({ guildId: ctx.guildId!, userId: ctx.author.id, action, tracks, queueLength: players.get(ctx.guildId!)?.queue.length ?? 0 });
      if (r === 'vote') return action === 'skip' ? 'vote' : null;
      if (r) throw new UserError(r);
      return null;
    };

    cog.command({
      name: 'play',
      description: 'Spielt Musik: YouTube-Suche/-Link, Playlist oder "jf: <suche>" für Jellyfin.',
      aliases: ['p'],
      guildOnly: true,
      permissions: voicePerms,
      options: [{ name: 'suche', description: 'Suchbegriff oder Link', type: OptionType.String, required: true, rest: true }],
      examples: ['play never gonna give you up', 'play https://youtu.be/dQw4w9WgXcQ', 'play jf: Daft Punk'],
      run: async (ctx) => {
        const vc = userVoice(ctx);
        await ctx.typing();
        const tracks = await resolveQuery(ctx.arg<string>('suche'), ctx.author.id);
        const wasRunning = players.get(ctx.guildId!)?.running ?? false;
        await guard(ctx, 'enqueue', tracks);
        await enqueue(ctx.guildId!, vc, ctx.channelId, tracks);
        if (tracks.length > 1) await ctx.reply(ctx.t('addedMany', { count: tracks.length }));
        else if (wasRunning) await ctx.reply(ctx.t('added', { title: tracks[0]!.title, pos: players.get(ctx.guildId!)!.queue.length }));
      },
    });

    cog.command({
      name: 'jellyfin',
      description: 'Sucht auf dem Jellyfin-Server (Titel, Alben, Playlists) – Auswahl per Reaktion.',
      aliases: ['jf'],
      guildOnly: true,
      permissions: voicePerms,
      options: [{ name: 'suche', description: 'Suchbegriff', type: OptionType.String, required: true, rest: true }],
      run: async (ctx) => {
        const vc = userVoice(ctx);
        await ctx.typing();
        const items = (await jellyfinSearch(ctx.arg<string>('suche'))).slice(0, 5);
        if (!items.length) throw new UserError(ctx.t('noHits'));
        const icon: Record<string, string> = { Audio: '🎵', MusicAlbum: '💿', Playlist: '📃' };
        const list = items.map((i, n) => `${NUMBER_EMOJIS[n]} ${icon[i.Type] ?? '🎵'} ${i.AlbumArtist ? `${i.AlbumArtist} – ` : ''}**${i.Name}**`).join('\n');
        const idx = items.length === 1 ? 0 : await ctx.choose(embed({ title: ctx.t('chooseTitle'), description: list }), items.length);
        if (idx === null) return ctx.reply(ctx.t('common.cancelled'));
        const tracks = await jellyfinTracks(items[idx]!, ctx.author.id);
        if (!tracks.length) throw new UserError(ctx.t('noHits'));
        await guard(ctx, 'enqueue', tracks);
        await enqueue(ctx.guildId!, vc, ctx.channelId, tracks);
        await ctx.reply(tracks.length > 1 ? ctx.t('addedMany', { count: tracks.length }) : ctx.t('added', { title: tracks[0]!.title, pos: players.get(ctx.guildId!)!.queue.length }));
      },
    });

    cog.command({
      name: 'search',
      description: 'YouTube durchsuchen und per Reaktion auswählen.',
      aliases: ['yt'],
      guildOnly: true,
      permissions: voicePerms,
      options: [{ name: 'suche', description: 'Suchbegriff', type: OptionType.String, required: true, rest: true }],
      run: async (ctx) => {
        const vc = userVoice(ctx);
        await ctx.typing();
        const hits = await youtubeSearch(ctx.arg<string>('suche'), 5);
        if (!hits.length) throw new UserError(ctx.t('noHits'));
        const list = hits.map((h, n) => `${NUMBER_EMOJIS[n]} **${h.title}** (${formatDuration(h.duration)})`).join('\n');
        const idx = await ctx.choose(embed({ title: ctx.t('chooseTitle'), description: list }), hits.length);
        if (idx === null) return ctx.reply(ctx.t('common.cancelled'));
        const h = hits[idx]!;
        const picked: Track[] = [{ title: h.title, source: 'youtube', ref: `https://www.youtube.com/watch?v=${h.id}`, duration: h.duration, requester: ctx.author.id }];
        await guard(ctx, 'enqueue', picked);
        await enqueue(ctx.guildId!, vc, ctx.channelId, picked);
        await ctx.tick();
      },
    });

    cog.command({
      name: 'queue',
      description: 'Warteschlange anzeigen.',
      aliases: ['q'],
      guildOnly: true,
      run: async (ctx) => {
        const pl = requirePlayer(ctx);
        const lines = pl.queue.map((t, i) => `\`${i + 1}\` ${t.title} (${formatDuration(t.duration)}) – <@${t.requester}>`);
        const total = pl.queue.reduce((s, t) => s + (t.duration ?? 0), 0);
        const head = pl.current ? `▶️ **${pl.current.title}**\n${ctx.t('queueInfo', { count: pl.queue.length, time: humanizeSeconds(total, 2), loop: ctx.t(`loop.${pl.loop}`) })}\n\n` : '';
        const pages = pagify(lines.join('\n') || ctx.t('queueEmpty'), { pageLength: 1500 }).map((pg) => embed({ title: ctx.t('queueTitle'), description: head + pg }));
        await ctx.paginate(pages);
      },
    });

    cog.command({
      name: 'np',
      description: 'Was läuft gerade?',
      aliases: ['nowplaying'],
      guildOnly: true,
      run: async (ctx) => {
        const pl = requirePlayer(ctx);
        if (!pl.current) throw new UserError(ctx.t('nothingPlaying'));
        await ctx.reply(ctx.t('nowPlaying', { title: pl.current.title, duration: formatDuration(pl.current.duration), user: `<@${pl.current.requester}>` }));
      },
    });

    cog.command({
      name: 'skip',
      description: 'Aktuellen Titel überspringen.',
      aliases: ['next'],
      guildOnly: true,
      run: async (ctx) => {
        userVoice(ctx);
        const pl = requirePlayer(ctx);
        // Wer den Titel gewünscht hat, darf ihn immer überspringen.
        if (pl.current?.requester !== ctx.author.id && (await guard(ctx, 'skip')) === 'vote') {
          const guild = p().getGuild(ctx.guildId!);
          const listeners = [...(guild?.voiceStates.values() ?? [])].filter(
            (s) => s.channel_id === pl.voiceChannelId && s.user_id !== p().user?.id && !(guild?.members.get(s.user_id)?.user as { bot?: boolean } | undefined)?.bot,
          ).length;
          pl.votes.add(ctx.author.id);
          const needed = Math.max(1, Math.ceil(listeners / 2));
          if (pl.votes.size < needed) return ctx.reply(ctx.t('voteAdded', { votes: pl.votes.size, needed }));
        }
        api.skip(ctx.guildId!);
        await ctx.react('⏭️');
      },
    });

    cog.command({
      name: 'remove',
      description: 'Titel aus der Warteschlange entfernen.',
      guildOnly: true,
      options: [{ name: 'nummer', description: 'Position', type: OptionType.Integer, required: true, min_value: 1 }],
      run: async (ctx) => {
        const pl = requirePlayer(ctx);
        const target = pl.queue[ctx.arg<number>('nummer') - 1];
        if (target && target.requester !== ctx.author.id) await guard(ctx, 'remove');
        const [t] = pl.queue.splice(ctx.arg<number>('nummer') - 1, 1);
        if (!t) throw new UserError(ctx.t('noSuchTrack'));
        await ctx.reply(ctx.t('removedTrack', { title: t.title }));
      },
    });

    cog.command({
      name: 'stop',
      description: 'Wiedergabe beenden, Warteschlange leeren und Kanal verlassen.',
      aliases: ['leave', 'disconnect', 'dc'],
      guildOnly: true,
      run: async (ctx) => {
        await guard(ctx, 'stop');
        destroy(ctx.guildId!);
        await ctx.react('⏹️');
      },
    });

    cog.command({
      name: 'volume',
      description: 'Lautstärke 0–200 % (ohne Angabe: anzeigen).',
      aliases: ['vol'],
      guildOnly: true,
      options: [{ name: 'prozent', description: '0–200', type: OptionType.Integer, min_value: 0, max_value: 200 }],
      run: async (ctx) => {
        const v = ctx.arg<number | undefined>('prozent');
        if (v === undefined) return ctx.reply(ctx.t('volumeIs', { volume: cog.config.guild(ctx.guildId!).get<number>('volume') }));
        await guard(ctx, 'volume');
        cog.config.guild(ctx.guildId!).set('volume', v);
        cog.bot.voice.get(ctx.guildId!)?.conn.setVolume(v);
        await ctx.reply(ctx.t('volumeSet', { volume: v }));
      },
    });

    cog.group({
      name: 'musicset',
      description: 'Musik-Einstellungen.',
      guildOnly: true,
      permissions: { level: 'admin', member: ['ManageGuild'] },
      subcommands: [
        {
          name: 'announce',
          description: '„Jetzt läuft“-Nachrichten an/aus.',
          options: [{ name: 'aktiv', description: 'an/aus', type: OptionType.Boolean, required: true }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('announce', ctx.arg<boolean>('aktiv'));
            await ctx.tick();
          },
        },
        {
          name: 'idle',
          description: 'Sekunden ohne Musik/Zuhörer, bis der Bot den Kanal verlässt.',
          options: [{ name: 'sekunden', description: 'Sekunden', type: OptionType.Integer, required: true, min_value: 10, max_value: 3600 }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('idleLeave', ctx.arg<number>('sekunden'));
            await ctx.tick();
          },
        },
        {
          name: 'status',
          description: 'Diagnose: yt-dlp, Jellyfin und Sprachverbindung.',
          run: async (ctx) => {
            const yt = await run(ytdlp, ['--version'], { timeout: 15_000 }).then((r) => r.stdout.trim()).catch(() => null);
            let jf = ctx.t('diag.noKey');
            if (jfKey) jf = await fetchJson<{ ServerName?: string; Version?: string }>(`${jfUrl}/System/Info/Public`, { signal: cog.signal }).then((i) => `✅ ${i.ServerName ?? ''} ${i.Version ?? ''}`).catch(() => ctx.t('diag.unreachable'));
            const session = cog.bot.voice.get(ctx.guildId!);
            await ctx.reply(ctx.t('diag.text', { yt: yt ? `✅ ${yt}` : '❌', jfUrl, jf, voice: session ? `✅ <#${session.channelId}>` : '–' }));
          },
        },
      ],
    });
  },
});
