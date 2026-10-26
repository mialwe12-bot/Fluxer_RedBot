import type { DB } from '../db/database.js';
import { hasPermissions, PermissionFlags } from '../platform/permissionBits.js';
import type { CachedGuild } from '../platform/types.js';
import type { Command, PermissionLevel } from '../commands/types.js';

export const LEVEL_ORDER: Record<PermissionLevel, number> = {
  everyone: 0,
  mod: 1,
  admin: 2,
  guildowner: 3,
  owner: 4,
};

export type RuleScope = 'global' | string; // 'global' oder Guild-ID
export type RuleSubject = `user:${string}` | `role:${string}` | `channel:${string}` | `guild:${string}` | 'default';
export type RuleModel = `cog:${string}` | `cmd:${string}`;

export interface PermissionRule {
  id: number;
  scope: RuleScope;
  model: RuleModel;
  subject: RuleSubject;
  allow: boolean;
}

/** Was die Prüfung über den Aufrufer wissen muss. */
export interface CheckSubject {
  userId: string;
  guildId?: string | undefined;
  channelId: string;
  /** Kategorie (parent_id) des Kanals, falls vorhanden. */
  categoryId?: string | null | undefined;
  /** Voice-Kanal, in dem der User gerade ist. */
  voiceChannelId?: string | null | undefined;
}

/** Abhängigkeiten zur Plattform/Config – in Tests leicht zu fälschen. */
export interface PermissionEnvironment {
  isOwner(userId: string): boolean;
  getGuild(guildId: string): CachedGuild | undefined;
  /** Server-weite Rechte des Mitglieds (Rollen). */
  memberPermissions(guildId: string, userId: string): Promise<bigint>;
  memberRoles(guildId: string, userId: string): Promise<string[]>;
  adminRoles(guildId: string): string[];
  modRoles(guildId: string): string[];
}

export type CheckResult =
  | { allowed: true; via: 'owner' | 'rule' | 'level' | 'permissions' }
  | { allowed: false; reason: 'rule' | 'level'; required?: PermissionLevel };

export class PermissionManager {
  private readonly stmts;

  constructor(
    db: DB,
    private readonly env: PermissionEnvironment,
  ) {
    this.stmts = {
      upsert: db.prepare(
        `INSERT INTO permission_rules (scope_id, model, subject, allow) VALUES (?, ?, ?, ?)
         ON CONFLICT (scope_id, model, subject) DO UPDATE SET allow = excluded.allow`,
      ),
      remove: db.prepare('DELETE FROM permission_rules WHERE scope_id = ? AND model = ? AND subject = ?'),
      clearScope: db.prepare('DELETE FROM permission_rules WHERE scope_id = ?'),
      clearModel: db.prepare('DELETE FROM permission_rules WHERE scope_id = ? AND model = ?'),
      list: db.prepare('SELECT id, scope_id, model, subject, allow FROM permission_rules WHERE scope_id = ? ORDER BY model, subject'),
      forModels: db.prepare('SELECT id, scope_id, model, subject, allow FROM permission_rules WHERE scope_id IN (?, ?)'),
    };
  }

  // ------------------------------------------------------------ Regeln verwalten

  setRule(scope: RuleScope, model: RuleModel, subject: RuleSubject, allow: boolean): void {
    this.stmts.upsert.run(scope, model, subject, allow ? 1 : 0);
  }

  removeRule(scope: RuleScope, model: RuleModel, subject: RuleSubject): boolean {
    return this.stmts.remove.run(scope, model, subject).changes > 0;
  }

  clearRules(scope: RuleScope, model?: RuleModel): number {
    return (model ? this.stmts.clearModel.run(scope, model) : this.stmts.clearScope.run(scope)).changes;
  }

  listRules(scope: RuleScope): PermissionRule[] {
    return (this.stmts.list.all(scope) as RawRule[]).map(toRule);
  }

  // ------------------------------------------------------------ Stufen

  /** Höchste Berechtigungsstufe des Users im Kontext. */
  async levelOf(subject: CheckSubject): Promise<PermissionLevel> {
    if (this.env.isOwner(subject.userId)) return 'owner';
    if (!subject.guildId) return 'everyone';
    const guild = this.env.getGuild(subject.guildId);
    if (guild && guild.owner_id === subject.userId) return 'guildowner';
    const roles = await this.env.memberRoles(subject.guildId, subject.userId);
    const perms = await this.env.memberPermissions(subject.guildId, subject.userId);
    const adminRoles = this.env.adminRoles(subject.guildId);
    if ((perms & PermissionFlags.Administrator) !== 0n || roles.some((r) => adminRoles.includes(r))) return 'admin';
    const modRoles = this.env.modRoles(subject.guildId);
    if (roles.some((r) => modRoles.includes(r))) return 'mod';
    return 'everyone';
  }

  // ------------------------------------------------------------ Regeln auswerten

  /** Reihenfolge der Subjekte wie bei Red: User → Voice-Kanal → Kanal → Kategorie → Rollen (höchste zuerst) → Server. */
  private async subjectsFor(subject: CheckSubject): Promise<RuleSubject[]> {
    const list: RuleSubject[] = [`user:${subject.userId}`];
    if (subject.voiceChannelId) list.push(`channel:${subject.voiceChannelId}`);
    list.push(`channel:${subject.channelId}`);
    if (subject.categoryId) list.push(`channel:${subject.categoryId}`);
    if (subject.guildId) {
      const guild = this.env.getGuild(subject.guildId);
      const roles = await this.env.memberRoles(subject.guildId, subject.userId);
      const sorted = [...roles].sort((a, b) => (guild?.roles.get(b)?.position ?? 0) - (guild?.roles.get(a)?.position ?? 0));
      for (const r of sorted) list.push(`role:${r}`);
      list.push(`guild:${subject.guildId}`);
    }
    return list;
  }

  /** Models eines Befehls: der Befehl selbst, dann seine Elterngruppen, dann der Cog. */
  static modelsFor(command: Pick<Command, 'qualifiedName' | 'cogName' | 'parent'>): RuleModel[] {
    const models: RuleModel[] = [];
    let cur: Pick<Command, 'qualifiedName' | 'parent'> | undefined = command;
    while (cur) {
      models.push(`cmd:${cur.qualifiedName}`);
      cur = cur.parent;
    }
    models.push(`cog:${command.cogName.toLowerCase()}`);
    return models;
  }

  /**
   * Wertet Regeln aus. Globale Regeln (Owner) vor Server-Regeln; innerhalb eines Scopes
   * Befehl vor Elterngruppe vor Cog; je Model die Subjekt-Reihenfolge aus subjectsFor();
   * zuletzt die Default-Regeln. Ergebnis: true (erlaubt), false (verboten), undefined (keine Regel).
   */
  async evaluate(command: Pick<Command, 'qualifiedName' | 'cogName' | 'parent'>, subject: CheckSubject): Promise<boolean | undefined> {
    const scopes = ['global', ...(subject.guildId ? [subject.guildId] : [])];
    const rows = (this.stmts.forModels.all('global', subject.guildId ?? 'global') as RawRule[]).map(toRule);
    if (rows.length === 0) return undefined;
    const index = new Map<string, boolean>();
    for (const r of rows) index.set(`${r.scope}|${r.model}|${r.subject}`, r.allow);
    const models = PermissionManager.modelsFor(command);
    const subjects = await this.subjectsFor(subject);
    for (const scope of scopes) {
      for (const model of models) {
        for (const s of subjects) {
          const hit = index.get(`${scope}|${model}|${s}`);
          if (hit !== undefined) return hit;
        }
      }
    }
    for (const scope of scopes) {
      for (const model of models) {
        const hit = index.get(`${scope}|${model}|default`);
        if (hit !== undefined) return hit;
      }
    }
    return undefined;
  }

  /**
   * Vollständige Prüfung eines Befehls:
   * 1. Bot-Owner dürfen alles.
   * 2. Verbots-Regel → verboten. Erlaubnis-Regel → erlaubt (außer für owner/guildowner-Befehle).
   * 3. Sonst Stufe des Users ≥ Stufe des Befehls, oder alternativ die geforderten Server-Rechte
   *    (wie Reds *_or_permissions; gilt nicht für owner-Befehle).
   */
  async check(command: Command, subject: CheckSubject): Promise<CheckResult> {
    if (this.env.isOwner(subject.userId)) return { allowed: true, via: 'owner' };
    const required = command.permissions?.level ?? 'everyone';
    const rule = await this.evaluate(command, subject);
    if (rule === false) return { allowed: false, reason: 'rule' };
    if (rule === true && LEVEL_ORDER[required] <= LEVEL_ORDER.admin) return { allowed: true, via: 'rule' };
    const level = await this.levelOf(subject);
    if (LEVEL_ORDER[level] >= LEVEL_ORDER[required]) return { allowed: true, via: 'level' };
    const alt = command.permissions?.member;
    if (alt?.length && subject.guildId && LEVEL_ORDER[required] < LEVEL_ORDER.owner) {
      const perms = await this.env.memberPermissions(subject.guildId, subject.userId);
      if (hasPermissions(perms, alt)) return { allowed: true, via: 'permissions' };
    }
    return { allowed: false, reason: 'level', required };
  }
}

interface RawRule {
  id: number;
  scope_id: string;
  model: string;
  subject: string;
  allow: number;
}

function toRule(r: RawRule): PermissionRule {
  return { id: r.id, scope: r.scope_id, model: r.model as RuleModel, subject: r.subject as RuleSubject, allow: r.allow === 1 };
}
