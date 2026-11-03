import type { Bot } from '../bot.js';
import type { CommandDefinition } from '../commands/types.js';
import { Config } from '../config/config.js';
import { migrate, type DB } from '../db/database.js';
import type { Translator, Vars } from '../i18n/i18n.js';
import type { Logger } from '../logger.js';
import type { FluxerPlatform } from '../platform/platform.js';
import type { TaskSpec } from '../scheduler/scheduler.js';
import type { CogManifest } from '../sdk/index.js';

/** Events, die vom Bot selbst kommen (nicht vom Gateway). */
export const BOT_EVENTS = new Set([
  'ready',
  'commandNotFound',
  'commandCompleted',
  'commandError',
  'cogLoaded',
  'cogUnloaded',
]);

type Listener = (...args: any[]) => unknown;

/**
 * Gateway-Events heißen GROSS_MIT_UNTERSTRICH (MESSAGE_CREATE …) und kommen von der Plattform,
 * dazu die Plattform-Zustände connected/disconnected/gatewayError. Alles andere sind Bot-Events –
 * die eingebauten (BOT_EVENTS) oder eigene, die Cogs mit cog.emit() senden (z. B. "levelUp").
 */
export function isPlatformEvent(event: string): boolean {
  return /^[A-Z0-9_]+$/.test(event) || event === '*' || ['connected', 'disconnected', 'gatewayError'].includes(event);
}

/**
 * Laufzeitobjekt eines geladenen Cogs. Wird an `setup(cog)` übergeben.
 * Alles, was hier registriert wird, räumt der Loader beim Entladen automatisch ab.
 */
export class Cog {
  readonly config: Config;
  readonly log: Logger;
  /** Übersetzer: sucht zuerst in den Texten des Cogs, dann im Kern. */
  readonly t: Translator;
  /** Wird beim Entladen abgebrochen – für fetch()/Timer im Cog verwenden. */
  readonly signal: AbortSignal;

  /** @internal */ readonly commandDefs: CommandDefinition[] = [];
  /** @internal */ readonly listeners: Array<{ event: string; target: 'bot' | 'platform'; fn: Listener; wrapped?: Listener }> = [];
  /** @internal */ readonly tasks: TaskSpec[] = [];
  /** @internal */ readonly unloadHooks: Array<() => unknown> = [];
  /** @internal */ readonly readyHooks: Array<() => unknown> = [];
  /** @internal */ active = false;
  private readonly controller = new AbortController();
  private readonly i18nNamespace: string;

  constructor(
    readonly bot: Bot,
    readonly manifest: CogManifest,
    readonly dir: string,
    readonly internal = false,
  ) {
    this.config = new Config(bot.configStore, manifest.name);
    this.log = bot.log.child({ cog: manifest.name });
    this.signal = this.controller.signal;
    this.i18nNamespace = `cog:${manifest.name}`;
    this.t = (key: string, vars?: Vars) => bot.i18n.t([this.i18nNamespace, 'core'], key, vars, bot.defaultLocale());
  }

  get name(): string {
    return this.manifest.name;
  }

  /** Anzeigename (Kategorie in der Hilfe). */
  get displayName(): string {
    return this.manifest.displayName ?? this.manifest.name.charAt(0).toUpperCase() + this.manifest.name.slice(1);
  }

  get platform(): FluxerPlatform {
    return this.bot.platform;
  }

  /** Direkter Zugriff auf SQLite für eigene Tabellen. Bitte Tabellen mit `cog_<name>_` präfixen. */
  get db(): DB {
    return this.bot.db;
  }

  get tablePrefix(): string {
    return `cog_${this.name.replace(/[^a-z0-9_]/gi, '_')}_`;
  }

  /** Übersetzung für eine bestimmte Guild (berücksichtigt deren Spracheinstellung). */
  tg(guildId: string | undefined, key: string, vars?: Vars): string {
    return this.bot.i18n.t([this.i18nNamespace, 'core'], key, vars, this.bot.localeFor(guildId));
  }

  /** Eigene Tabellen-Migrationen (laufen genau einmal, in Reihenfolge). */
  migrate(statements: string[]): void {
    migrate(this.bot.db, `cog:${this.name}`, statements);
  }

  /** Registriert einen Befehl (mit `subcommands` als Gruppe). */
  command(def: CommandDefinition): this {
    if (this.active) {
      this.bot.registry.register(def, this.name, this.displayName);
    }
    this.commandDefs.push(def);
    return this;
  }

  /** Alias für command() – für Lesbarkeit bei Gruppen. */
  group(def: CommandDefinition & { subcommands: CommandDefinition[] }): this {
    return this.command(def);
  }

  /**
   * Event-Listener. Gateway-Events heißen wie bei Fluxer/Discord ('MESSAGE_CREATE', 'VOICE_STATE_UPDATE', …);
   * Bot-Events: ready, commandNotFound, commandCompleted, commandError, cogLoaded, cogUnloaded.
   * Fehler im Handler werden geloggt und crashen den Bot nie.
   */
  on(event: string, fn: Listener): this {
    const entry = { event, target: (isPlatformEvent(event) ? 'platform' : 'bot') as 'bot' | 'platform', fn };
    this.listeners.push(entry);
    if (this.active) this.attachListener(entry);
    return this;
  }

  /** @internal */
  attachListener(entry: (typeof this.listeners)[number]): void {
    const wrapped: Listener = (...args) => {
      try {
        const result = entry.fn(...args);
        if (result && typeof (result as Promise<unknown>).catch === 'function') {
          (result as Promise<unknown>).catch((err) => this.log.error({ err, event: entry.event }, 'Fehler im Event-Listener'));
        }
      } catch (err) {
        this.log.error({ err, event: entry.event }, 'Fehler im Event-Listener');
      }
    };
    entry.wrapped = wrapped;
    (entry.target === 'bot' ? this.bot.events : this.bot.platform).on(entry.event, wrapped);
  }

  /** @internal */
  detachListeners(): void {
    for (const entry of this.listeners) {
      if (entry.wrapped) (entry.target === 'bot' ? this.bot.events : this.bot.platform).off(entry.event, entry.wrapped);
    }
  }

  /** Eigenes Bot-Event senden, das andere Cogs mit cog.on(name) empfangen. */
  emit(event: string, ...args: unknown[]): void {
    if (isPlatformEvent(event)) throw new Error(`"${event}" ist ein Gateway-Eventname – bitte camelCase verwenden.`);
    this.bot.events.emit(event, ...args);
  }

  /** Geplanter Task (cron/every/at), läuft in der Bot-Zeitzone. */
  schedule(spec: TaskSpec): this {
    this.tasks.push(spec);
    if (this.active) this.bot.scheduler.add(`cog:${this.name}`, spec);
    return this;
  }

  /** Wird aufgerufen, sobald der Bot verbunden ist (sofort, falls er es schon ist). */
  onReady(fn: () => unknown): this {
    this.readyHooks.push(fn);
    if (this.active && this.bot.isReady) void this.runHook(fn, 'onReady');
    return this;
  }

  /** Aufräumen beim Entladen (zusätzlich zu teardown()). */
  onUnload(fn: () => unknown): this {
    this.unloadHooks.push(fn);
    return this;
  }

  /** @internal */
  async runHook(fn: () => unknown, label: string): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.log.error({ err }, `Fehler in ${label}`);
    }
  }

  /** Öffentliche Schnittstelle dieses Cogs für andere Cogs (siehe expose()). */
  api: unknown = undefined;

  /**
   * Stellt anderen Cogs eine Schnittstelle bereit. Abhängige Cogs holen sie mit
   * `cog.bot.cogApi<ModlogApi>('modlog')` (undefined, wenn der Cog nicht geladen ist).
   */
  expose<T>(api: T): T {
    this.api = api;
    return api;
  }

  /** @internal */
  abort(): void {
    this.controller.abort();
  }
}
