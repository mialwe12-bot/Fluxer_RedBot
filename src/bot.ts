import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { CogLoader, APP_ROOT } from './cogs/loader.js';
import { CommandDispatcher } from './commands/dispatcher.js';
import { CooldownManager } from './commands/cooldowns.js';
import { CommandRegistry } from './commands/registry.js';
import { Config, ConfigStore } from './config/config.js';
import { coreCogDefinition, CORE_MANIFEST } from './core/coreCog.js';
import { HelpFormatter } from './core/help.js';
import type { DB } from './db/database.js';
import type { Env } from './env.js';
import { I18n, type Vars } from './i18n/i18n.js';
import type { Logger } from './logger.js';
import { PermissionFlags } from './platform/permissionBits.js';
import { VoiceService } from './platform/voiceService.js';
import type { FluxerPlatform } from './platform/platform.js';
import type { APIMessage, BotStatus, MessagePayload } from './platform/types.js';
import { LEVEL_ORDER, PermissionManager } from './permissions/permissions.js';
import type { PermissionLevel } from './commands/types.js';
import { Scheduler } from './scheduler/scheduler.js';
import { embedToText } from './utils/embeds.js';
import { MESSAGE_LIMIT, pagify } from './utils/format.js';
import * as menus from './utils/menus.js';

export const EXIT_SHUTDOWN = 0;
export const EXIT_RESTART = 26;

export interface BotOptions {
  env: Env;
  platform: FluxerPlatform;
  db: DB;
  logger: Logger;
  /** Überschreibt die Cog-Suchpfade (Tests). */
  cogPaths?: Array<{ dir: string; source: 'installed' | 'builtin' }>;
  cacheDir?: string;
  /** Standard-Cogs beim allerersten Start. */
  defaultCogs?: string[];
}

export interface RecordedError {
  id: string;
  command: string;
  at: Date;
  stack: string;
}

function readVersion(): string {
  try {
    return (JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

/** Der Kern: verbindet Plattform, Config, Befehle, Rechte, Scheduler und Cog-Loader. */
export class Bot {
  readonly events = new EventEmitter();
  readonly version = readVersion();
  readonly startedAt = new Date();
  readonly env: Env;
  readonly log: Logger;
  readonly db: DB;
  readonly configStore: ConfigStore;
  /** Config-Namensraum des Kerns. */
  readonly core: Config;
  readonly i18n: I18n;
  readonly platform: FluxerPlatform;
  readonly registry = new CommandRegistry();
  readonly cooldowns = new CooldownManager();
  readonly permissions: PermissionManager;
  readonly scheduler: Scheduler;
  readonly collector: menus.ReactionCollector;
  readonly help: HelpFormatter;
  readonly cogs: CogLoader;
  readonly dispatcher: CommandDispatcher;
  /** Sprachverbindungen (Audio über LiveKit, experimentell). */
  readonly voice: VoiceService;
  readonly menus;
  isReady = false;
  appOwnerId: string | null = null;
  readonly recentErrors: RecordedError[] = [];
  private healthTimer: NodeJS.Timeout | undefined;
  private stopping = false;
  /** Wird von index.ts gesetzt, um den Prozess zu beenden. */
  exit: (code: number) => void = (code) => process.exit(code);

  constructor(private readonly options: BotOptions) {
    this.env = options.env;
    this.log = options.logger;
    this.db = options.db;
    this.platform = options.platform;
    this.events.setMaxListeners(0);
    this.configStore = new ConfigStore(this.db);
    this.core = new Config(this.configStore, 'core');
    this.core.registerGlobal({
      prefixes: [] as string[],
      owners: [] as string[],
      loadedCogs: [] as string[],
      initialized: false,
      locale: null as string | null,
      embeds: true,
      status: { status: 'online', text: null } as { status: BotStatus; text: string | null },
    });
    this.core.registerGuild({
      prefixes: [] as string[],
      adminRoles: [] as string[],
      modRoles: [] as string[],
      locale: null as string | null,
      embeds: null as boolean | null,
      /** Benutzer-/Rollen-IDs, die von Automod/Filtern ausgenommen sind (Red: autoimmune). */
      immune: [] as string[],
    });
    this.i18n = new I18n(this.env.locale);
    this.i18n.loadDirectory('core', path.join(APP_ROOT, 'locales'));
    this.scheduler = new Scheduler(this.env.timezone, this.log.child({ module: 'scheduler' }));
    this.permissions = new PermissionManager(this.db, {
      isOwner: (id) => this.isOwner(id),
      getGuild: (id) => this.platform.getGuild(id),
      memberPermissions: (g, u) => this.platform.memberPermissions(g, u),
      memberRoles: async (g, u) => {
        const m = this.platform.getMember(g, u) ?? (await this.platform.fetchMember(g, u).catch(() => undefined));
        return m?.roles ?? [];
      },
      adminRoles: (g) => this.core.guild(g).get<string[]>('adminRoles'),
      modRoles: (g) => this.core.guild(g).get<string[]>('modRoles'),
    });
    this.collector = new menus.ReactionCollector(this.platform);
    const deps = (guildId?: string): menus.MenuDeps => ({
      platform: this.platform,
      collector: this.collector,
      render: async (page, _i, _total) =>
        this.adaptPayload(typeof page === 'string' ? { content: page } : { embeds: [page] }, guildId, undefined),
    });
    this.menus = {
      paginate: (channelId: string, userId: string, pages: menus.Page[], guildId?: string, timeoutMs?: number) =>
        menus.paginate(deps(guildId), channelId, userId, pages, timeoutMs ? { timeoutMs } : {}),
      confirm: (channelId: string, userId: string, q: menus.Page, guildId?: string, timeoutMs?: number) =>
        menus.confirm(deps(guildId), channelId, userId, q, timeoutMs),
      choose: (channelId: string, userId: string, page: menus.Page, count: number, guildId?: string, timeoutMs?: number) =>
        menus.choose(deps(guildId), channelId, userId, page, count, timeoutMs),
    };
    this.help = new HelpFormatter(this);
    this.cogs = new CogLoader(this, {
      paths: options.cogPaths ?? [
        { dir: path.join(this.env.dataDir, 'cogs'), source: 'installed' },
        { dir: path.join(APP_ROOT, 'cogs'), source: 'builtin' },
      ],
      cacheDir: options.cacheDir ?? path.join(APP_ROOT, '.cogcache'),
      extraNodePaths: [path.join(this.env.dataDir, 'cog-libs', 'node_modules')],
    });
    this.dispatcher = new CommandDispatcher(this);
    this.voice = new VoiceService(this.platform, this.log.child({ module: 'voice' }));
  }

  // ------------------------------------------------------------------ Einstellungen

  owners(): Set<string> {
    const set = new Set<string>([...this.env.ownerIds, ...this.core.global().get<string[]>('owners')]);
    if (this.appOwnerId) set.add(this.appOwnerId);
    return set;
  }

  isOwner(userId: string): boolean {
    return this.owners().has(userId);
  }

  globalPrefixes(): string[] {
    const custom = this.core.global().get<string[]>('prefixes');
    return custom.length ? custom : [this.env.prefix];
  }

  prefixesFor(guildId?: string): string[] {
    if (guildId) {
      const g = this.core.guild(guildId).get<string[]>('prefixes');
      if (g.length) return g;
    }
    return this.globalPrefixes();
  }

  defaultLocale(): string {
    return this.core.global().get<string | null>('locale') ?? this.env.locale;
  }

  localeFor(guildId?: string): string {
    return (guildId ? this.core.guild(guildId).get<string | null>('locale') : null) ?? this.defaultLocale();
  }

  /** Kern-Übersetzung. */
  t(key: string, vars?: Vars, guildId?: string): string {
    return this.i18n.t('core', key, vars, this.localeFor(guildId));
  }

  /** Embeds erlaubt? (global, pro Guild, und Bot hat "Links einbetten") */
  async canEmbed(guildId?: string, channelId?: string): Promise<boolean> {
    if (!this.core.global().get<boolean>('embeds')) return false;
    if (!guildId) return true;
    const guildSetting = this.core.guild(guildId).get<boolean | null>('embeds');
    if (guildSetting === false) return false;
    const guild = this.platform.getGuild(guildId);
    if (!guild || !this.platform.user || guild.roles.size === 0) return true; // unbekannt → versuchen
    return this.platform.botCan(guildId, channelId, PermissionFlags.EmbedLinks).catch(() => true);
  }

  /** Ersetzt Embeds durch Text, wenn Embeds nicht möglich/gewünscht sind. */
  async adaptPayload(payload: MessagePayload, guildId?: string, channelId?: string): Promise<MessagePayload> {
    if (!payload.embeds?.length) return payload;
    if (await this.canEmbed(guildId, channelId)) return payload;
    return toTextPayload(payload);
  }

  /**
   * Sendet eine Nachricht robust: teilt zu lange Texte und fällt bei abgelehnten Embeds auf Text zurück.
   * Gibt die (letzte) gesendete Nachricht zurück.
   */
  async send(channelId: string, payload: MessagePayload, _guildId?: string): Promise<APIMessage> {
    const content = payload.content ?? '';
    if (content.length > MESSAGE_LIMIT) {
      const pages = pagify(content);
      let last: APIMessage | undefined;
      for (let i = 0; i < pages.length; i++) {
        const isLast = i === pages.length - 1;
        last = await this.sendOne(channelId, isLast ? { ...payload, content: pages[i] } : { content: pages[i], allowed_mentions: payload.allowed_mentions });
      }
      return last!;
    }
    return this.sendOne(channelId, payload);
  }

  private async sendOne(channelId: string, payload: MessagePayload): Promise<APIMessage> {
    try {
      return await this.platform.sendMessage(channelId, payload);
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (payload.embeds?.length && (status === 403 || status === 400)) {
        this.log.debug({ err }, 'Embed abgelehnt – sende Text-Fallback');
        return this.send(channelId, toTextPayload(payload));
      }
      throw err;
    }
  }

  /** Schnittstelle eines geladenen Cogs (siehe cog.expose()). */
  cogApi<T>(name: string): T | undefined {
    return this.cogs.loaded.get(name)?.api as T | undefined;
  }

  /** Berechtigungsstufe eines Users auf einem Server. */
  async levelOf(guildId: string | undefined, userId: string): Promise<PermissionLevel> {
    return this.permissions.levelOf({ userId, guildId, channelId: '' });
  }

  /**
   * Von Automatiken (Filter, Automod, Einladungssperre …) ausgenommen?
   * Wie bei Red: Mods und höher, der Bot selbst sowie per `autoimmune` eingetragene User/Rollen.
   */
  async isImmune(guildId: string, userId: string): Promise<boolean> {
    if (userId === this.platform.user?.id) return true;
    const immune = this.core.guild(guildId).get<string[]>('immune');
    if (immune.includes(userId)) return true;
    const member = this.platform.getMember(guildId, userId);
    if (member?.roles?.some((r) => immune.includes(r))) return true;
    return LEVEL_ORDER[await this.levelOf(guildId, userId)] >= LEVEL_ORDER.mod;
  }

  /**
   * Rollen-Hierarchie für Moderationsaktionen prüfen. Liefert einen i18n-Schlüssel (Kern) bei Verstoß,
   * sonst null. Bot-Owner und Serverbesitzer dürfen alle außer dem Serverbesitzer moderieren.
   */
  hierarchyProblem(guildId: string, actorId: string, targetId: string): string | null {
    const guild = this.platform.getGuild(guildId);
    if (actorId === targetId) return 'hierarchy.self';
    if (targetId === this.platform.user?.id) return 'hierarchy.bot';
    if (guild && targetId === guild.owner_id) return 'hierarchy.owner';
    const target = this.platform.topRolePosition(guildId, targetId);
    if (!this.isOwner(actorId) && guild?.owner_id !== actorId) {
      if (this.platform.topRolePosition(guildId, actorId) <= target) return 'hierarchy.actor';
    }
    if (this.platform.user && this.platform.topRolePosition(guildId, this.platform.user.id) <= target) return 'hierarchy.botRole';
    return null;
  }

  recordError(command: string, err: unknown, id: string): void {
    const stack = err instanceof Error ? (err.stack ?? err.message) : String(err);
    this.recentErrors.unshift({ id, command, at: new Date(), stack });
    this.recentErrors.length = Math.min(this.recentErrors.length, 20);
  }

  /** OAuth2-Einladungslink (Scope "bot"). */
  inviteUrl(permissions: bigint = defaultInvitePermissions()): string | null {
    const appId = this.platform.applicationId;
    if (!appId) return null;
    const q = new URLSearchParams({ client_id: appId, scope: 'bot', permissions: permissions.toString() });
    return `${this.env.baseUrl}/oauth2/authorize?${q}`;
  }

  // ------------------------------------------------------------------ Lebenszyklus

  /** Verdrahtet Events und lädt Cogs. Verbindet noch nicht (siehe connect()). */
  async init(): Promise<void> {
    this.platform.on('MESSAGE_CREATE', (message: APIMessage) => {
      this.dispatcher.handleMessage(message).catch((err) => this.log.error({ err }, 'Fehler im Dispatcher'));
    });
    this.platform.on('READY', () => this.onReady());
    this.platform.on('connected', () => {
      if (!this.isReady) this.onReady();
    });

    await this.cogs.loadInternal(CORE_MANIFEST, coreCogDefinition);

    const g = this.core.global();
    if (!g.get<boolean>('initialized')) {
      g.set('loadedCogs', this.options.defaultCogs ?? ['downloader', 'permissions', 'example']);
      g.set('initialized', true);
    }
    for (const name of g.get<string[]>('loadedCogs')) {
      if (this.cogs.isLoaded(name)) continue;
      try {
        await this.cogs.load(name);
      } catch (err) {
        this.log.error({ err, cog: name }, 'Cog konnte beim Start nicht geladen werden');
      }
    }
  }

  private onReady(): void {
    const firstReady = !this.isReady;
    this.isReady = true;
    if (!firstReady) return;
    const status = this.core.global().get<{ status: BotStatus; text: string | null }>('status');
    try {
      this.platform.setPresence(status.status, status.text);
    } catch (err) {
      this.log.warn({ err }, 'Status konnte nicht gesetzt werden');
    }
    void this.fetchApplicationOwner();
    this.cogs.runReadyHooks();
    this.events.emit('ready');
    this.log.info({ user: this.platform.user?.username, guilds: this.platform.guilds.size }, 'Bot bereit');
  }

  private async fetchApplicationOwner(): Promise<void> {
    try {
      const app = await this.platform.rest.get<{ id?: string; owner?: { id: string } }>('/oauth2/applications/@me');
      if (app.owner?.id) this.appOwnerId = app.owner.id;
      if (app.id && !this.platform.applicationId) this.platform.applicationId = app.id;
    } catch (err) {
      this.log.debug({ err }, 'Application-Owner nicht abrufbar (BOT_OWNER_IDS setzen)');
    }
  }

  /** Verbindet mit dem Gateway und startet Healthcheck/Watchdog. */
  async connect(): Promise<void> {
    this.startHealth();
    await this.platform.connect();
  }

  /**
   * Merkt sich, welche Cogs beim nächsten Start geladen werden sollen. Cogs, die beim Start
   * fehlschlagen, bleiben in der Liste (ein vorübergehender Fehler soll den Zustand nicht löschen).
   */
  rememberCogs(names: string[], loaded: boolean): void {
    this.core.global().update<string[]>('loadedCogs', (list) => {
      const set = new Set(list ?? []);
      for (const n of names) {
        if (loaded) set.add(n);
        else set.delete(n);
      }
      return [...set].sort();
    });
  }

  private startHealth(): void {
    const file = path.join(this.env.dataDir, 'health.json');
    const write = () => {
      const p = this.platform;
      const data = {
        ts: Date.now(),
        connected: p.connected,
        disconnectedSince: p.disconnectedSince,
        guilds: p.guilds.size,
        cogs: this.cogs.loaded.size,
      };
      try {
        fs.writeFileSync(file, JSON.stringify(data));
      } catch (err) {
        this.log.warn({ err }, 'health.json konnte nicht geschrieben werden');
      }
      // Watchdog: zu lange ohne Gateway → Prozess beenden, Docker startet neu.
      if (p.disconnectedSince && Date.now() - p.disconnectedSince > this.env.watchdogSeconds * 1000) {
        this.log.fatal({ seconds: this.env.watchdogSeconds }, 'Watchdog: zu lange keine Gateway-Verbindung – Neustart');
        void this.shutdown(1);
      }
      this.cooldowns.sweep();
    };
    write();
    this.healthTimer = setInterval(write, 30_000);
    this.healthTimer.unref();
  }

  /** Sauber herunterfahren (Cogs entladen, DB schließen) und mit Code beenden. */
  async shutdown(code: number = EXIT_SHUTDOWN): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.log.info({ code }, code === EXIT_RESTART ? 'Neustart …' : 'Fahre herunter …');
    if (this.healthTimer) clearInterval(this.healthTimer);
    try {
      await this.cogs.unloadAll();
    } catch (err) {
      this.log.warn({ err }, 'Fehler beim Entladen der Cogs');
    }
    this.scheduler.stopAll();
    this.voice.destroyAll();
    this.platform.destroy();
    try {
      this.db.close();
    } catch {
      /* bereits geschlossen */
    }
    this.exit(code);
  }
}

export function toTextPayload(payload: MessagePayload): MessagePayload {
  const { embeds, ...rest } = payload;
  const text = [rest.content, ...(embeds ?? []).map(embedToText)].filter(Boolean).join('\n\n');
  return { ...rest, content: text };
}

/** Rechte, die der Einladungslink standardmäßig anfragt. */
export function defaultInvitePermissions(): bigint {
  const f = PermissionFlags;
  return (
    f.ViewChannel | f.SendMessages | f.EmbedLinks | f.AttachFiles | f.ReadMessageHistory | f.AddReactions |
    f.ManageMessages | f.ManageRoles | f.KickMembers | f.BanMembers | f.ModerateMembers | f.MoveMembers |
    f.ManageNicknames | f.Connect | f.Speak | f.UseExternalEmojis | f.ManageChannels | f.ViewAuditLog
  );
}
