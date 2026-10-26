import { EventEmitter } from 'node:events';
import type { Logger } from '../logger.js';
import {
  computeBasePermissions,
  computeChannelPermissions,
  PermissionFlags,
} from './permissionBits.js';
import type {
  APIChannel,
  APIGuildMember,
  APIMessage,
  APIRole,
  APIUser,
  APIVoiceState,
  BotStatus,
  CachedGuild,
  GatewayLike,
  MessagePayload,
  PresenceData,
  RestLike,
  RestRequestOptions,
} from './types.js';
import { VoiceUnsupportedError } from './voice.js';

/** Eintrag im Nachrichten-Cache. */
export interface CachedMessage {
  id: string;
  channel_id: string;
  guild_id: string | null;
  author: { id: string; username: string; bot: boolean };
  content: string;
  attachments: string[];
  created_at: number;
  edited_at: number | null;
}

/** Gateway-Opcodes, die der Bot selbst sendet. */
const OP_PRESENCE_UPDATE = 3;
const OP_VOICE_STATE_UPDATE = 4;
const OP_REQUEST_GUILD_MEMBERS = 8;

export interface PlatformOptions {
  rest: RestLike;
  gateway?: GatewayLike;
  logger: Logger;
}

type AnyRecord = Record<string, any>;

/**
 * Plattform-Schicht für Fluxer: kapselt REST + Gateway, pflegt einen schlanken Cache
 * (Guilds, Rollen, Kanäle, Mitglieder, Voice-States, Presences) und berechnet Rechte.
 *
 * Events: alle Gateway-Dispatches unter ihrem Namen (z. B. 'MESSAGE_CREATE', 'VOICE_STATE_UPDATE')
 * sowie 'connected', 'disconnected', 'gatewayError'.
 * Als zweites Argument kommt – soweit bekannt – der vorherige Zustand: VOICE_STATE_UPDATE (Voice-State),
 * GUILD_MEMBER_UPDATE/REMOVE (Mitglied), GUILD_ROLE_UPDATE/DELETE (Rolle), CHANNEL_UPDATE/DELETE (Kanal),
 * MESSAGE_UPDATE/DELETE (gecachte Nachricht), MESSAGE_DELETE_BULK (Liste gecachter Nachrichten).
 */
export class FluxerPlatform extends EventEmitter {
  readonly rest: RestLike;
  readonly gateway: GatewayLike | undefined;
  readonly guilds = new Map<string, CachedGuild>();
  readonly users = new Map<string, APIUser>();
  /**
   * Kleiner Nachrichten-Cache (nur für Bearbeitungs-/Lösch-Logs, z. B. extendedmodlog).
   * Fluxer schickt bei MESSAGE_DELETE nur IDs – ohne Cache wäre der Inhalt unbekannt.
   */
  readonly messages = new Map<string, CachedMessage>();
  messageCacheSize = 5000;
  /** DM-Kanal-ID je User-ID. */
  private readonly dmChannels = new Map<string, string>();
  /** Kanal-ID → Guild-ID (für schnelle Zuordnung). */
  private readonly channelGuild = new Map<string, string>();
  private readonly log: Logger;

  user: APIUser | null = null;
  applicationId: string | null = null;
  connected = false;
  disconnectedSince: number | null = Date.now();
  lastEventAt = 0;
  private presence: { status: BotStatus; text: string | null } = { status: 'online', text: null };

  constructor(options: PlatformOptions) {
    super();
    this.setMaxListeners(0);
    this.rest = options.rest;
    this.gateway = options.gateway;
    this.log = options.logger;
    if (this.gateway) {
      this.gateway.on('dispatch', (event: { shardId: number; payload: { t: string; d: unknown } }) => {
        this.handleDispatch(event.payload.t, event.payload.d);
      });
      this.gateway.on('ready', () => this.markConnected());
      this.gateway.on('resumed', () => this.markConnected());
      this.gateway.on('close', (event: { shardId: number; code: number }) => {
        this.markDisconnected(`close ${event?.code ?? '?'}`);
      });
      this.gateway.on('error', (event: { error?: Error } | Error) => {
        const error = event instanceof Error ? event : event?.error;
        this.logGatewayError(error);
        this.emit('gatewayError', error);
      });
      this.gateway.on('debug', (msg: string) => this.log.trace({ gateway: msg }, 'gateway debug'));
    }
  }

  private gatewayErrorLog = { last: 0, suppressed: 0 };

  /** Gateway-Fehler höchstens alle 30 s loggen (bei Ausfällen feuert die Bibliothek pro Versuch mehrfach). */
  private logGatewayError(error: Error | undefined): void {
    const now = Date.now();
    if (now - this.gatewayErrorLog.last < 30_000) {
      this.gatewayErrorLog.suppressed++;
      return;
    }
    this.log.warn({ err: error, suppressed: this.gatewayErrorLog.suppressed }, 'Gateway-Fehler');
    this.gatewayErrorLog = { last: now, suppressed: 0 };
  }

  private markConnected(): void {
    if (!this.connected) this.log.info('Gateway verbunden');
    this.connected = true;
    this.disconnectedSince = null;
    this.emit('connected');
  }

  private markDisconnected(reason: string): void {
    if (this.connected) this.log.warn({ reason }, 'Gateway getrennt – Wiederverbindung läuft automatisch');
    this.connected = false;
    this.disconnectedSince ??= Date.now();
    this.emit('disconnected', reason);
  }

  async connect(): Promise<void> {
    if (!this.gateway) throw new Error('Kein Gateway konfiguriert');
    await this.gateway.connect();
  }

  destroy(): void {
    this.gateway?.destroy();
    this.connected = false;
    this.removeAllListeners();
  }

  // ---------------------------------------------------------------- Dispatch/Cache

  /** Verarbeitet ein Gateway-Event: Cache aktualisieren, dann weiterreichen. Öffentlich für Tests. */
  handleDispatch(type: string, data: unknown): void {
    this.lastEventAt = Date.now();
    const d = (data ?? {}) as AnyRecord;
    let extra: unknown;
    try {
      extra = this.updateCache(type, d);
    } catch (err) {
      this.log.warn({ err, type }, 'Cache-Aktualisierung fehlgeschlagen');
    }
    this.emit(type, d, extra);
    this.emit('*', type, d, extra);
  }

  private updateCache(type: string, d: AnyRecord): unknown {
    switch (type) {
      case 'READY': {
        this.user = d.user ?? null;
        if (this.user) this.users.set(this.user.id, this.user);
        if (d.application?.id) this.applicationId = String(d.application.id);
        for (const g of (d.guilds ?? []) as AnyRecord[]) this.upsertGuild(g);
        this.markConnected();
        return undefined;
      }
      case 'RESUMED':
        this.markConnected();
        return undefined;
      case 'GUILD_CREATE':
      case 'GUILD_UPDATE':
        this.upsertGuild(d);
        return undefined;
      case 'GUILD_DELETE': {
        if (!d.unavailable) {
          const g = this.guilds.get(d.id);
          if (g) for (const c of g.channels.keys()) this.channelGuild.delete(c);
          this.guilds.delete(d.id);
        }
        return undefined;
      }
      case 'GUILD_ROLE_CREATE':
      case 'GUILD_ROLE_UPDATE': {
        const g = this.guilds.get(d.guild_id);
        const previous = g && d.role ? g.roles.get(d.role.id) : undefined;
        if (g && d.role) g.roles.set(d.role.id, d.role);
        return previous;
      }
      case 'GUILD_ROLE_UPDATE_BULK': {
        const g = this.guilds.get(d.guild_id);
        if (g) for (const r of (d.roles ?? []) as APIRole[]) g.roles.set(r.id, r);
        return undefined;
      }
      case 'GUILD_ROLE_DELETE': {
        const g = this.guilds.get(d.guild_id);
        const previous = g?.roles.get(d.role_id);
        g?.roles.delete(d.role_id);
        return previous;
      }
      case 'CHANNEL_CREATE':
      case 'CHANNEL_UPDATE': {
        const previous = this.getChannel(d.id);
        this.upsertChannel(d as APIChannel);
        return previous;
      }
      case 'CHANNEL_UPDATE_BULK':
        for (const c of (d.channels ?? []) as APIChannel[]) this.upsertChannel(c);
        return undefined;
      case 'CHANNEL_DELETE': {
        const gid = d.guild_id ?? this.channelGuild.get(d.id);
        const previous = this.getChannel(d.id);
        if (gid) this.guilds.get(gid)?.channels.delete(d.id);
        this.channelGuild.delete(d.id);
        return previous;
      }
      case 'GUILD_MEMBER_ADD':
      case 'GUILD_MEMBER_UPDATE': {
        const g = this.guilds.get(d.guild_id);
        if (g && d.user) {
          const previous = g.members.get(d.user.id);
          g.members.set(d.user.id, { ...(previous ?? {}), ...d } as APIGuildMember);
          this.users.set(d.user.id, d.user);
          if (type === 'GUILD_MEMBER_ADD') g.member_count += 1;
          return previous;
        }
        return undefined;
      }
      case 'GUILD_MEMBERS_CHUNK': {
        const g = this.guilds.get(d.guild_id);
        if (g) for (const m of (d.members ?? []) as APIGuildMember[]) this.cacheMember(g, m);
        return undefined;
      }
      case 'GUILD_MEMBER_REMOVE': {
        const g = this.guilds.get(d.guild_id);
        if (g && d.user) {
          const previous = g.members.get(d.user.id);
          g.members.delete(d.user.id);
          g.member_count = Math.max(0, g.member_count - 1);
          return previous;
        }
        return undefined;
      }
      case 'MESSAGE_CREATE': {
        if (d.author) this.users.set(d.author.id, d.author);
        if (d.guild_id && d.member && d.author) {
          const g = this.guilds.get(d.guild_id);
          if (g) this.cacheMember(g, { ...d.member, user: d.author });
        }
        this.cacheMessage(d as APIMessage);
        return undefined;
      }
      case 'MESSAGE_UPDATE': {
        const previous = this.messages.get(d.id);
        if (previous && typeof d.content === 'string') {
          this.messages.set(d.id, { ...previous, content: d.content, edited_at: Date.now() });
        }
        return previous;
      }
      case 'MESSAGE_DELETE': {
        const previous = this.messages.get(d.id);
        this.messages.delete(d.id);
        return previous;
      }
      case 'MESSAGE_DELETE_BULK': {
        const previous: CachedMessage[] = [];
        for (const id of (d.ids ?? []) as string[]) {
          const m = this.messages.get(id);
          if (m) previous.push(m);
          this.messages.delete(id);
        }
        return previous;
      }
      case 'VOICE_STATE_UPDATE': {
        const gid: string | undefined = d.guild_id ?? undefined;
        const g = gid ? this.guilds.get(gid) : undefined;
        if (!g) return undefined;
        const previous = g.voiceStates.get(d.user_id);
        if (d.channel_id) g.voiceStates.set(d.user_id, d as APIVoiceState);
        else g.voiceStates.delete(d.user_id);
        if (d.member) this.cacheMember(g, d.member);
        return previous;
      }
      case 'PRESENCE_UPDATE': {
        this.cachePresence(d);
        return undefined;
      }
      case 'PRESENCE_UPDATE_BULK': {
        for (const p of (d.presences ?? []) as AnyRecord[]) this.cachePresence({ guild_id: d.guild_id, ...p });
        return undefined;
      }
      case 'USER_UPDATE': {
        if (this.user && d.id === this.user.id) this.user = { ...this.user, ...d };
        return undefined;
      }
      default:
        return undefined;
    }
  }

  private cacheMessage(m: APIMessage): void {
    if (!m?.id || !m.author) return;
    this.messages.set(m.id, {
      id: m.id,
      channel_id: m.channel_id,
      guild_id: m.guild_id ?? null,
      author: { id: m.author.id, username: m.author.username, bot: Boolean((m.author as { bot?: boolean }).bot) },
      content: m.content ?? '',
      attachments: (m.attachments ?? []).map((a) => a.url ?? a.filename),
      created_at: Date.now(),
      edited_at: null,
    });
    if (this.messages.size > this.messageCacheSize) {
      const oldest = this.messages.keys().next().value;
      if (oldest !== undefined) this.messages.delete(oldest);
    }
  }

  private cachePresence(d: AnyRecord): void {
    const userId = d.user?.id;
    if (!userId) return;
    const targets = d.guild_id ? [this.guilds.get(d.guild_id)] : [...this.guilds.values()];
    for (const g of targets) {
      if (!g) continue;
      if (d.guild_id || g.members.has(userId)) {
        g.presences.set(userId, { status: d.status, activities: d.activities, custom_status: d.custom_status });
      }
    }
  }

  private cacheMember(g: CachedGuild, m: APIGuildMember): void {
    if (!m?.user?.id) return;
    const previous = g.members.get(m.user.id);
    g.members.set(m.user.id, { ...(previous ?? {}), ...m } as APIGuildMember);
    this.users.set(m.user.id, m.user as APIUser);
  }

  private upsertGuild(raw: AnyRecord): void {
    if (!raw?.id) return;
    // Fluxer liefert Guild-Felder teils direkt, teils unter `properties`.
    const props: AnyRecord = { ...(raw.properties ?? {}), ...raw };
    const existing = this.guilds.get(raw.id);
    const g: CachedGuild = existing ?? {
      id: raw.id,
      name: '',
      owner_id: '',
      icon: null,
      afk_channel_id: null,
      member_count: 0,
      roles: new Map(),
      channels: new Map(),
      members: new Map(),
      voiceStates: new Map(),
      presences: new Map(),
    };
    if (props.name !== undefined) g.name = props.name;
    if (props.owner_id !== undefined) g.owner_id = String(props.owner_id);
    if (props.icon !== undefined) g.icon = props.icon;
    if (props.afk_channel_id !== undefined) g.afk_channel_id = props.afk_channel_id;
    if (typeof props.member_count === 'number') g.member_count = props.member_count;
    this.guilds.set(g.id, g);
    if (Array.isArray(props.roles)) {
      g.roles.clear();
      for (const r of props.roles as APIRole[]) g.roles.set(r.id, r);
    }
    if (Array.isArray(props.channels)) for (const c of props.channels as APIChannel[]) this.upsertChannel({ ...c, guild_id: g.id });
    if (Array.isArray(props.threads)) for (const c of props.threads as APIChannel[]) this.upsertChannel({ ...c, guild_id: g.id });
    if (Array.isArray(props.members)) for (const m of props.members as APIGuildMember[]) this.cacheMember(g, m);
    if (Array.isArray(props.voice_states)) {
      for (const vs of props.voice_states as APIVoiceState[]) {
        if (vs.channel_id) g.voiceStates.set(vs.user_id, { ...vs, guild_id: g.id });
      }
    }
    if (Array.isArray(props.presences)) for (const p of props.presences as AnyRecord[]) this.cachePresence({ ...p, guild_id: g.id });
  }

  private upsertChannel(c: APIChannel): void {
    const gid = c.guild_id ?? this.channelGuild.get(c.id);
    if (!gid) return;
    const g = this.guilds.get(gid);
    if (!g) return;
    g.channels.set(c.id, { ...(g.channels.get(c.id) ?? {}), ...c, guild_id: gid } as APIChannel);
    this.channelGuild.set(c.id, gid);
  }

  // ---------------------------------------------------------------- Cache-Zugriff

  getGuild(guildId: string): CachedGuild | undefined {
    return this.guilds.get(guildId);
  }

  getChannel(channelId: string): APIChannel | undefined {
    const gid = this.channelGuild.get(channelId);
    return gid ? this.guilds.get(gid)?.channels.get(channelId) : undefined;
  }

  guildIdOfChannel(channelId: string): string | undefined {
    return this.channelGuild.get(channelId);
  }

  getMember(guildId: string, userId: string): APIGuildMember | undefined {
    return this.guilds.get(guildId)?.members.get(userId);
  }

  getVoiceState(guildId: string, userId: string): APIVoiceState | undefined {
    return this.guilds.get(guildId)?.voiceStates.get(userId);
  }

  getPresence(guildId: string, userId: string): PresenceData | undefined {
    return this.guilds.get(guildId)?.presences.get(userId);
  }

  // ---------------------------------------------------------------- Rechte

  /** Rechte eines Mitglieds (mit Kanal-Overwrites, wenn channelId angegeben). Holt das Mitglied bei Bedarf. */
  async memberPermissions(guildId: string, userId: string, channelId?: string): Promise<bigint> {
    const guild = this.guilds.get(guildId);
    if (!guild) return 0n;
    const member = this.getMember(guildId, userId) ?? (await this.fetchMember(guildId, userId).catch(() => undefined));
    if (!member) return 0n;
    const m = { roles: member.roles ?? [], user: { id: userId } };
    if (!channelId) return computeBasePermissions(guild, m);
    let channel = guild.channels.get(channelId);
    // Threads erben die Rechte des Elternkanals.
    if (channel?.parent_id && [10, 11, 12].includes(Number(channel.type))) {
      channel = guild.channels.get(channel.parent_id) ?? channel;
    }
    return computeChannelPermissions(guild, m, channel);
  }

  async botPermissions(guildId: string, channelId?: string): Promise<bigint> {
    if (!this.user) return 0n;
    return this.memberPermissions(guildId, this.user.id, channelId);
  }

  /** Höchste Rollenposition eines Mitglieds (Owner = unendlich). Für Hierarchie-Prüfungen. */
  topRolePosition(guildId: string, userId: string): number {
    const g = this.guilds.get(guildId);
    if (!g) return 0;
    if (g.owner_id === userId) return Number.POSITIVE_INFINITY;
    const m = g.members.get(userId);
    let top = 0;
    for (const r of m?.roles ?? []) top = Math.max(top, g.roles.get(r)?.position ?? 0);
    return top;
  }

  // ---------------------------------------------------------------- REST: Nachrichten

  private withReason(reason?: string, extra: RestRequestOptions = {}): RestRequestOptions {
    return reason ? { ...extra, headers: { ...(extra.headers ?? {}), 'X-Audit-Log-Reason': encodeURIComponent(reason) } } : extra;
  }

  async sendMessage(channelId: string, payload: MessagePayload | string): Promise<APIMessage> {
    const p: MessagePayload = typeof payload === 'string' ? { content: payload } : payload;
    const { files, ...body } = p;
    const options: RestRequestOptions = { body };
    if (files?.length) options.files = files.map((f) => ({ name: f.name, filename: f.name, data: f.data }));
    return this.rest.post<APIMessage>(`/channels/${channelId}/messages`, options);
  }

  async editMessage(channelId: string, messageId: string, payload: MessagePayload | string): Promise<APIMessage> {
    const p: MessagePayload = typeof payload === 'string' ? { content: payload } : payload;
    const { files: _files, ...body } = p;
    return this.rest.patch<APIMessage>(`/channels/${channelId}/messages/${messageId}`, { body });
  }

  async deleteMessage(channelId: string, messageId: string, reason?: string): Promise<void> {
    await this.rest.delete(`/channels/${channelId}/messages/${messageId}`, this.withReason(reason));
  }

  async bulkDeleteMessages(channelId: string, messageIds: string[]): Promise<void> {
    if (messageIds.length === 0) return;
    if (messageIds.length === 1) return this.deleteMessage(channelId, messageIds[0]!);
    await this.rest.post(`/channels/${channelId}/messages/bulk-delete`, { body: { messages: messageIds } });
  }

  async fetchMessage(channelId: string, messageId: string): Promise<APIMessage> {
    return this.rest.get<APIMessage>(`/channels/${channelId}/messages/${messageId}`);
  }

  async fetchMessages(channelId: string, options: { limit?: number; before?: string; after?: string } = {}): Promise<APIMessage[]> {
    const q = new URLSearchParams();
    q.set('limit', String(Math.min(100, Math.max(1, options.limit ?? 50))));
    if (options.before) q.set('before', options.before);
    if (options.after) q.set('after', options.after);
    return this.rest.get<APIMessage[]>(`/channels/${channelId}/messages?${q}`);
  }

  async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    await this.rest.put(`/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`);
  }

  async removeReaction(channelId: string, messageId: string, emoji: string, userId?: string): Promise<void> {
    const who = userId ?? '@me';
    await this.rest.delete(`/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/${who}`);
  }

  async removeAllReactions(channelId: string, messageId: string): Promise<void> {
    await this.rest.delete(`/channels/${channelId}/messages/${messageId}/reactions`);
  }

  async triggerTyping(channelId: string): Promise<void> {
    await this.rest.post(`/channels/${channelId}/typing`);
  }

  /** Öffnet (oder nutzt) einen DM-Kanal. */
  async createDM(userId: string): Promise<string> {
    const cached = this.dmChannels.get(userId);
    if (cached) return cached;
    const channel = await this.rest.post<APIChannel>('/users/@me/channels', { body: { recipient_id: userId } });
    this.dmChannels.set(userId, channel.id);
    return channel.id;
  }

  async sendDM(userId: string, payload: MessagePayload | string): Promise<APIMessage> {
    const channelId = await this.createDM(userId);
    return this.sendMessage(channelId, payload);
  }

  // ---------------------------------------------------------------- REST: Guilds/Mitglieder

  async fetchGuild(guildId: string): Promise<CachedGuild | undefined> {
    const raw = await this.rest.get<AnyRecord>(`/guilds/${guildId}`);
    this.upsertGuild(raw);
    if (!this.guilds.get(guildId)?.channels.size) {
      const channels = await this.rest.get<APIChannel[]>(`/guilds/${guildId}/channels`).catch(() => []);
      for (const c of channels) this.upsertChannel({ ...c, guild_id: guildId });
    }
    return this.guilds.get(guildId);
  }

  async fetchMember(guildId: string, userId: string): Promise<APIGuildMember> {
    const member = await this.rest.get<APIGuildMember>(`/guilds/${guildId}/members/${userId}`);
    const g = this.guilds.get(guildId);
    if (g) this.cacheMember(g, member);
    return member;
  }

  async fetchChannel(channelId: string): Promise<APIChannel> {
    const channel = await this.rest.get<APIChannel>(`/channels/${channelId}`);
    this.upsertChannel(channel);
    return channel;
  }

  async fetchUser(userId: string): Promise<APIUser> {
    const cached = this.users.get(userId);
    if (cached) return cached;
    const user = await this.rest.get<APIUser>(`/users/${userId}`);
    this.users.set(user.id, user);
    return user;
  }

  /** Fordert alle Mitglieder einer Guild über das Gateway an (Ergebnis kommt per GUILD_MEMBERS_CHUNK). */
  requestGuildMembers(guildId: string): void {
    this.gateway?.send(0, { op: OP_REQUEST_GUILD_MEMBERS, d: { guild_id: guildId, query: '', limit: 0 } });
  }

  async editMember(guildId: string, userId: string, body: AnyRecord, reason?: string): Promise<APIGuildMember> {
    return this.rest.patch<APIGuildMember>(`/guilds/${guildId}/members/${userId}`, this.withReason(reason, { body }));
  }

  /** Mitglied in einen anderen Voice-Kanal verschieben (null = trennen). Benötigt "Mitglieder verschieben". */
  async moveMember(guildId: string, userId: string, channelId: string | null, reason?: string): Promise<void> {
    await this.editMember(guildId, userId, { channel_id: channelId }, reason);
  }

  /** Timeout setzen (until = null hebt ihn auf). Benötigt "Mitglieder moderieren". */
  async timeoutMember(guildId: string, userId: string, until: Date | null, reason?: string): Promise<void> {
    const body: AnyRecord = { communication_disabled_until: until ? until.toISOString() : null };
    if (reason) body.timeout_reason = reason;
    await this.editMember(guildId, userId, body, reason);
  }

  async addRole(guildId: string, userId: string, roleId: string, reason?: string): Promise<void> {
    await this.rest.put(`/guilds/${guildId}/members/${userId}/roles/${roleId}`, this.withReason(reason));
  }

  async removeRole(guildId: string, userId: string, roleId: string, reason?: string): Promise<void> {
    await this.rest.delete(`/guilds/${guildId}/members/${userId}/roles/${roleId}`, this.withReason(reason));
  }

  async kickMember(guildId: string, userId: string, reason?: string): Promise<void> {
    await this.rest.delete(`/guilds/${guildId}/members/${userId}`, this.withReason(reason));
  }

  async banMember(guildId: string, userId: string, options: { reason?: string; deleteMessageSeconds?: number } = {}): Promise<void> {
    const body: AnyRecord = {};
    if (options.deleteMessageSeconds) body.delete_message_seconds = options.deleteMessageSeconds;
    if (options.reason) body.reason = options.reason;
    await this.rest.put(`/guilds/${guildId}/bans/${userId}`, this.withReason(options.reason, { body }));
  }

  async unbanMember(guildId: string, userId: string, reason?: string): Promise<void> {
    await this.rest.delete(`/guilds/${guildId}/bans/${userId}`, this.withReason(reason));
  }

  async fetchBans(guildId: string): Promise<Array<{ user: APIUser; reason?: string | null }>> {
    return (await this.rest.get<Array<{ user: APIUser; reason?: string | null }>>(`/guilds/${guildId}/bans`)) ?? [];
  }

  // ---------------------------------------------------------------- REST: Rollen/Kanäle/Einladungen

  async createRole(guildId: string, body: { name: string; permissions?: string; color?: number; hoist?: boolean; mentionable?: boolean }, reason?: string): Promise<APIRole> {
    const role = await this.rest.post<APIRole>(`/guilds/${guildId}/roles`, this.withReason(reason, { body }));
    this.guilds.get(guildId)?.roles.set(role.id, role);
    return role;
  }

  async editRole(guildId: string, roleId: string, body: Partial<{ name: string; permissions: string; color: number; hoist: boolean; mentionable: boolean }>, reason?: string): Promise<APIRole> {
    const role = await this.rest.patch<APIRole>(`/guilds/${guildId}/roles/${roleId}`, this.withReason(reason, { body }));
    if (role?.id) this.guilds.get(guildId)?.roles.set(role.id, role);
    return role;
  }

  async deleteRole(guildId: string, roleId: string, reason?: string): Promise<void> {
    await this.rest.delete(`/guilds/${guildId}/roles/${roleId}`, this.withReason(reason));
    this.guilds.get(guildId)?.roles.delete(roleId);
  }

  async editChannel(channelId: string, body: AnyRecord, reason?: string): Promise<APIChannel> {
    const channel = await this.rest.patch<APIChannel>(`/channels/${channelId}`, this.withReason(reason, { body }));
    if (channel?.id) this.upsertChannel(channel);
    return channel;
  }

  /** Kanal-Overwrite setzen (type 0 = Rolle, 1 = Mitglied). */
  async setChannelOverwrite(channelId: string, targetId: string, overwrite: { type: 0 | 1; allow: bigint; deny: bigint }, reason?: string): Promise<void> {
    const body = { type: overwrite.type, allow: overwrite.allow.toString(), deny: overwrite.deny.toString() };
    await this.rest.put(`/channels/${channelId}/permissions/${targetId}`, this.withReason(reason, { body }));
    const channel = this.getChannel(channelId);
    if (channel) {
      const list = (channel.permission_overwrites ?? []).filter((o) => o.id !== targetId);
      list.push({ id: targetId, ...body } as never);
      channel.permission_overwrites = list;
    }
  }

  async deleteChannelOverwrite(channelId: string, targetId: string, reason?: string): Promise<void> {
    await this.rest.delete(`/channels/${channelId}/permissions/${targetId}`, this.withReason(reason));
    const channel = this.getChannel(channelId);
    if (channel) channel.permission_overwrites = (channel.permission_overwrites ?? []).filter((o) => o.id !== targetId);
  }

  /** Einladung auflösen (für inviteblocklist). */
  async fetchInvite(code: string): Promise<{ code: string; guild?: { id: string; name: string } | null } | undefined> {
    return this.rest.get(`/invites/${encodeURIComponent(code)}`).catch(() => undefined) as Promise<
      { code: string; guild?: { id: string; name: string } | null } | undefined
    >;
  }

  async leaveGuild(guildId: string): Promise<void> {
    await this.rest.delete(`/users/@me/guilds/${guildId}`);
  }

  // ---------------------------------------------------------------- Bot-Profil/Presence

  async editCurrentUser(body: { username?: string; avatar?: string | null }): Promise<APIUser> {
    const user = await this.rest.patch<APIUser>('/users/@me', { body });
    this.user = { ...(this.user ?? {}), ...user } as APIUser;
    return user;
  }

  /** Setzt Status und (optional) Status-Text. Fluxer nutzt dafür custom_status. */
  setPresence(status: BotStatus, text: string | null = null): void {
    this.presence = { status, text };
    this.gateway?.send(0, {
      op: OP_PRESENCE_UPDATE,
      d: {
        since: null,
        afk: false,
        status,
        activities: [],
        custom_status: text ? { text } : null,
      },
    });
  }

  getPresenceSetting(): { status: BotStatus; text: string | null } {
    return { ...this.presence };
  }

  /**
   * Voice-Kanal betreten/verlassen (nur Signalisierung). Audio läuft auf Fluxer über LiveKit
   * und ist im Kern nicht implementiert – siehe src/platform/voice.ts.
   */
  updateVoiceState(guildId: string, channelId: string | null, options: { selfMute?: boolean; selfDeaf?: boolean } = {}): void {
    if (!this.gateway) throw new VoiceUnsupportedError('Kein Gateway verbunden.');
    this.gateway.send(0, {
      op: OP_VOICE_STATE_UPDATE,
      d: { guild_id: guildId, channel_id: channelId, self_mute: options.selfMute ?? false, self_deaf: options.selfDeaf ?? false },
    });
  }

  /** Hat der Bot in diesem Kanal die angegebenen Rechte? */
  async botCan(guildId: string, channelId: string | undefined, flag: bigint): Promise<boolean> {
    const bits = await this.botPermissions(guildId, channelId);
    return (bits & PermissionFlags.Administrator) !== 0n || (bits & flag) === flag;
  }
}
