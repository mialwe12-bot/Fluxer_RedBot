import type { DB } from '../db/database.js';

/**
 * Red-ähnliche Config-API auf SQLite-Basis.
 *
 *   cog.config.registerGuild({ enabled: false, channel: null });
 *   cog.config.guild(guildId).get('enabled');        // -> false (Default)
 *   cog.config.guild(guildId).set('enabled', true);
 *   cog.config.member(guildId, userId).update('xp', (xp) => xp + 10);
 *
 * Jeder Cog bekommt einen eigenen Namensraum. Die Aufrufe sind synchron (better-sqlite3);
 * ein `await` davor schadet nicht, falls man Red-Code portiert.
 */

export type ConfigValue = unknown;
export type ConfigData = Record<string, ConfigValue>;
export type BuiltinScope = 'global' | 'guild' | 'channel' | 'role' | 'member' | 'user';

export class ConfigError extends Error {}

const CUSTOM_PREFIX = 'custom:';

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

/** Gemeinsamer SQL-Zugriff für alle Namensräume. */
export class ConfigStore {
  private readonly stmts;

  constructor(readonly db: DB) {
    this.stmts = {
      get: db.prepare('SELECT value FROM config WHERE namespace = ? AND scope = ? AND scope_id = ? AND key = ?'),
      set: db.prepare(
        `INSERT INTO config (namespace, scope, scope_id, key, value) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (namespace, scope, scope_id, key) DO UPDATE SET value = excluded.value`,
      ),
      del: db.prepare('DELETE FROM config WHERE namespace = ? AND scope = ? AND scope_id = ? AND key = ?'),
      entity: db.prepare('SELECT key, value FROM config WHERE namespace = ? AND scope = ? AND scope_id = ?'),
      delEntity: db.prepare('DELETE FROM config WHERE namespace = ? AND scope = ? AND scope_id = ?'),
      scope: db.prepare('SELECT scope_id, key, value FROM config WHERE namespace = ? AND scope = ?'),
      scopePrefix: db.prepare(
        'SELECT scope_id, key, value FROM config WHERE namespace = ? AND scope = ? AND scope_id LIKE ? ESCAPE \'\\\'',
      ),
      delScope: db.prepare('DELETE FROM config WHERE namespace = ? AND scope = ?'),
      delScopePrefix: db.prepare(
        'DELETE FROM config WHERE namespace = ? AND scope = ? AND scope_id LIKE ? ESCAPE \'\\\'',
      ),
      delNamespace: db.prepare('DELETE FROM config WHERE namespace = ?'),
    };
  }

  get(ns: string, scope: string, id: string, key: string): { found: boolean; value?: ConfigValue } {
    const row = this.stmts.get.get(ns, scope, id, key) as { value: string } | undefined;
    return row ? { found: true, value: JSON.parse(row.value) } : { found: false };
  }

  set(ns: string, scope: string, id: string, key: string, value: ConfigValue): void {
    if (value === undefined) {
      this.stmts.del.run(ns, scope, id, key);
      return;
    }
    this.stmts.set.run(ns, scope, id, key, JSON.stringify(value));
  }

  delete(ns: string, scope: string, id: string, key: string): void {
    this.stmts.del.run(ns, scope, id, key);
  }

  entity(ns: string, scope: string, id: string): ConfigData {
    const out: ConfigData = {};
    for (const row of this.stmts.entity.all(ns, scope, id) as { key: string; value: string }[]) {
      out[row.key] = JSON.parse(row.value);
    }
    return out;
  }

  deleteEntity(ns: string, scope: string, id: string): void {
    this.stmts.delEntity.run(ns, scope, id);
  }

  scope(ns: string, scope: string, idPrefix?: string): Map<string, ConfigData> {
    const rows = (
      idPrefix === undefined
        ? this.stmts.scope.all(ns, scope)
        : this.stmts.scopePrefix.all(ns, scope, `${escapeLike(idPrefix)}%`)
    ) as { scope_id: string; key: string; value: string }[];
    const out = new Map<string, ConfigData>();
    for (const row of rows) {
      let data = out.get(row.scope_id);
      if (!data) out.set(row.scope_id, (data = {}));
      data[row.key] = JSON.parse(row.value);
    }
    return out;
  }

  deleteScope(ns: string, scope: string, idPrefix?: string): void {
    if (idPrefix === undefined) this.stmts.delScope.run(ns, scope);
    else this.stmts.delScopePrefix.run(ns, scope, `${escapeLike(idPrefix)}%`);
  }

  deleteNamespace(ns: string): void {
    this.stmts.delNamespace.run(ns);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Sicht auf genau ein Objekt (z. B. eine Guild) innerhalb eines Scopes. */
export class ScopedConfig<T extends ConfigData = ConfigData> {
  constructor(
    private readonly store: ConfigStore,
    private readonly ns: string,
    private readonly scope: string,
    private readonly id: string,
    private readonly defaults: () => ConfigData,
  ) {}

  /** Wert lesen; nicht gesetzte Werte liefern den registrierten Default. */
  get<K extends keyof T & string>(key: K): T[K];
  get<V = unknown>(key: string, fallback?: V): V;
  get(key: string, fallback?: unknown): unknown {
    const row = this.store.get(this.ns, this.scope, this.id, key);
    if (row.found) return row.value;
    const defaults = this.defaults();
    if (key in defaults) return clone(defaults[key]);
    if (arguments.length >= 2) return fallback;
    throw new ConfigError(`Config-Schlüssel "${key}" ist im Scope "${this.scope}" von "${this.ns}" nicht registriert.`);
  }

  set<K extends keyof T & string>(key: K, value: T[K]): void;
  set(key: string, value: unknown): void;
  set(key: string, value: unknown): void {
    this.store.set(this.ns, this.scope, this.id, key, value);
  }

  /** Lesen, verändern, schreiben – atomar in einer Transaktion. */
  update<V = unknown>(key: string, fn: (current: V) => V): V {
    return this.store.transaction(() => {
      const next = fn(this.get<V>(key, undefined as V));
      this.set(key, next);
      return next;
    });
  }

  has(key: string): boolean {
    return this.store.get(this.ns, this.scope, this.id, key).found;
  }

  /** Alle Werte inklusive Defaults. */
  all(): T {
    return { ...clone(this.defaults()), ...this.store.entity(this.ns, this.scope, this.id) } as T;
  }

  /** Nur explizit gespeicherte Werte (ohne Defaults). */
  raw(): Partial<T> {
    return this.store.entity(this.ns, this.scope, this.id) as Partial<T>;
  }

  setAll(values: Partial<T>): void {
    this.store.transaction(() => {
      for (const [k, v] of Object.entries(values)) this.set(k, v);
    });
  }

  /** `clear('key')` setzt einen Schlüssel auf den Default zurück, `clear()` das ganze Objekt. */
  clear(key?: string): void {
    if (key === undefined) this.store.deleteEntity(this.ns, this.scope, this.id);
    else this.store.delete(this.ns, this.scope, this.id, key);
  }
}

/** Config-Namensraum eines Cogs (oder des Kerns). */
export class Config {
  private readonly defaults = new Map<string, ConfigData>();

  constructor(
    private readonly store: ConfigStore,
    readonly namespace: string,
  ) {}

  private register(scope: string, defaults: ConfigData): void {
    const current = this.defaults.get(scope) ?? {};
    this.defaults.set(scope, { ...current, ...clone(defaults) });
  }

  registerGlobal(defaults: ConfigData): this {
    this.register('global', defaults);
    return this;
  }
  registerGuild(defaults: ConfigData): this {
    this.register('guild', defaults);
    return this;
  }
  registerChannel(defaults: ConfigData): this {
    this.register('channel', defaults);
    return this;
  }
  registerRole(defaults: ConfigData): this {
    this.register('role', defaults);
    return this;
  }
  registerMember(defaults: ConfigData): this {
    this.register('member', defaults);
    return this;
  }
  registerUser(defaults: ConfigData): this {
    this.register('user', defaults);
    return this;
  }
  /** Eigene Gruppe, z. B. `registerCustom('reminder', {...})` und `custom('reminder', guildId, id)`. */
  registerCustom(group: string, defaults: ConfigData): this {
    this.register(CUSTOM_PREFIX + group, defaults);
    return this;
  }

  private view<T extends ConfigData>(scope: string, id: string): ScopedConfig<T> {
    return new ScopedConfig<T>(this.store, this.namespace, scope, id, () => this.defaults.get(scope) ?? {});
  }

  global<T extends ConfigData = ConfigData>(): ScopedConfig<T> {
    return this.view<T>('global', '');
  }
  guild<T extends ConfigData = ConfigData>(guildId: string): ScopedConfig<T> {
    return this.view<T>('guild', guildId);
  }
  channel<T extends ConfigData = ConfigData>(channelId: string): ScopedConfig<T> {
    return this.view<T>('channel', channelId);
  }
  role<T extends ConfigData = ConfigData>(roleId: string): ScopedConfig<T> {
    return this.view<T>('role', roleId);
  }
  user<T extends ConfigData = ConfigData>(userId: string): ScopedConfig<T> {
    return this.view<T>('user', userId);
  }
  member<T extends ConfigData = ConfigData>(guildId: string, userId: string): ScopedConfig<T> {
    return this.view<T>('member', `${guildId}:${userId}`);
  }
  custom<T extends ConfigData = ConfigData>(group: string, ...ids: string[]): ScopedConfig<T> {
    return this.view<T>(CUSTOM_PREFIX + group, ids.join(':'));
  }

  private allOf<T extends ConfigData>(scope: string): Record<string, T> {
    const defaults = this.defaults.get(scope) ?? {};
    const out: Record<string, T> = {};
    for (const [id, data] of this.store.scope(this.namespace, scope)) {
      out[id] = { ...clone(defaults), ...data } as T;
    }
    return out;
  }

  /** Alle Guilds mit gespeicherten Daten (Defaults ergänzt). */
  allGuilds<T extends ConfigData = ConfigData>(): Record<string, T> {
    return this.allOf<T>('guild');
  }
  allChannels<T extends ConfigData = ConfigData>(): Record<string, T> {
    return this.allOf<T>('channel');
  }
  allRoles<T extends ConfigData = ConfigData>(): Record<string, T> {
    return this.allOf<T>('role');
  }
  allUsers<T extends ConfigData = ConfigData>(): Record<string, T> {
    return this.allOf<T>('user');
  }
  allCustom<T extends ConfigData = ConfigData>(group: string): Record<string, T> {
    return this.allOf<T>(CUSTOM_PREFIX + group);
  }

  /** Mitglieder gruppiert nach Guild: `{ [guildId]: { [userId]: data } }`. Optional nur eine Guild. */
  allMembers<T extends ConfigData = ConfigData>(guildId?: string): Record<string, Record<string, T>> {
    const defaults = this.defaults.get('member') ?? {};
    const rows = this.store.scope(this.namespace, 'member', guildId === undefined ? undefined : `${guildId}:`);
    const out: Record<string, Record<string, T>> = {};
    for (const [id, data] of rows) {
      const [g, u] = id.split(':') as [string, string];
      (out[g] ??= {})[u] = { ...clone(defaults), ...data } as T;
    }
    return out;
  }

  clearAllGuilds(): void {
    this.store.deleteScope(this.namespace, 'guild');
  }
  clearAllChannels(): void {
    this.store.deleteScope(this.namespace, 'channel');
  }
  clearAllRoles(): void {
    this.store.deleteScope(this.namespace, 'role');
  }
  clearAllUsers(): void {
    this.store.deleteScope(this.namespace, 'user');
  }
  clearAllCustom(group: string): void {
    this.store.deleteScope(this.namespace, CUSTOM_PREFIX + group);
  }
  /** Alle Mitgliederdaten löschen, optional nur für eine Guild. */
  clearAllMembers(guildId?: string): void {
    this.store.deleteScope(this.namespace, 'member', guildId === undefined ? undefined : `${guildId}:`);
  }
  /** Alle Daten des Namensraums löschen (z. B. beim Entfernen eines Cogs). */
  clearAll(): void {
    this.store.deleteNamespace(this.namespace);
  }
}
