import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/database.js';
import { PermissionManager, type PermissionEnvironment } from '../src/permissions/permissions.js';
import {
  computeBasePermissions,
  computeChannelPermissions,
  hasPermissions,
  PermissionFlags,
} from '../src/platform/permissionBits.js';
import type { CachedGuild } from '../src/platform/types.js';
import type { Command } from '../src/commands/types.js';
import { IDS } from './helpers.js';

const F = PermissionFlags;

function guild(): CachedGuild {
  const role = (id: string, name: string, position: number, perms: bigint) => ({
    id,
    name,
    position,
    permissions: perms.toString(),
    color: 0,
    hoist: false,
    mentionable: false,
  });
  return {
    id: IDS.guild,
    name: 'Test',
    owner_id: IDS.owner,
    icon: null,
    afk_channel_id: null,
    member_count: 4,
    roles: new Map([
      [IDS.guild, role(IDS.guild, '@everyone', 0, F.ViewChannel | F.SendMessages)],
      [IDS.roleAdmin, role(IDS.roleAdmin, 'Admins', 3, F.Administrator)],
      [IDS.roleMod, role(IDS.roleMod, 'Mods', 2, F.ManageMessages | F.KickMembers)],
      [IDS.roleMember, role(IDS.roleMember, 'Mitglied', 1, 0n)],
    ]),
    channels: new Map(),
    members: new Map(),
    voiceStates: new Map(),
    presences: new Map(),
  };
}

const MEMBER_ROLES: Record<string, string[]> = {
  [IDS.owner]: [],
  [IDS.admin]: [IDS.roleAdmin],
  [IDS.mod]: [IDS.roleMod, IDS.roleMember],
  [IDS.user]: [IDS.roleMember],
};

function setup(options: { modRoles?: string[]; adminRoles?: string[] } = {}) {
  const g = guild();
  const env: PermissionEnvironment = {
    isOwner: (id) => id === IDS.botOwner,
    getGuild: () => g,
    memberRoles: async (_g, u) => MEMBER_ROLES[u] ?? [],
    memberPermissions: async (_g, u) => computeBasePermissions(g, { roles: MEMBER_ROLES[u] ?? [], user: { id: u } }),
    adminRoles: () => options.adminRoles ?? [],
    modRoles: () => options.modRoles ?? [IDS.roleMod],
  };
  return { pm: new PermissionManager(openDatabase(':memory:'), env), g };
}

function cmd(qualifiedName: string, cogName: string, level: Command['permissions'] = undefined, parent?: Command): Command {
  return {
    name: qualifiedName.split(' ').pop()!,
    qualifiedName,
    description: '',
    cogName,
    category: cogName,
    children: new Map(),
    permissions: level,
    parent,
  };
}

const subject = (userId: string, extra: Partial<{ channelId: string; categoryId: string; voiceChannelId: string }> = {}) => ({
  userId,
  guildId: IDS.guild,
  channelId: extra.channelId ?? IDS.channel,
  categoryId: extra.categoryId ?? IDS.category,
  voiceChannelId: extra.voiceChannelId ?? null,
});

describe('Berechtigungsstufen', () => {
  it('erkennt Owner, Serverbesitzer, Admin (Recht oder Rolle), Mod und Jeder', async () => {
    const { pm } = setup();
    expect(await pm.levelOf(subject(IDS.botOwner))).toBe('owner');
    expect(await pm.levelOf(subject(IDS.owner))).toBe('guildowner');
    expect(await pm.levelOf(subject(IDS.admin))).toBe('admin');
    expect(await pm.levelOf(subject(IDS.mod))).toBe('mod');
    expect(await pm.levelOf(subject(IDS.user))).toBe('everyone');
    expect(await pm.levelOf({ userId: IDS.user, channelId: 'dm' })).toBe('everyone');
  });

  it('Admin-Rolle ohne Administrator-Recht zählt als Admin', async () => {
    const { pm } = setup({ adminRoles: [IDS.roleMember] });
    expect(await pm.levelOf(subject(IDS.user))).toBe('admin');
  });

  it('prüft Mindeststufe und alternative Server-Rechte', async () => {
    const { pm } = setup({ modRoles: [] });
    const kick = cmd('kick', 'mod', { level: 'mod', member: ['KickMembers'] });
    const strict = cmd('purge', 'mod', { level: 'mod' });
    // moritz hat keine Mod-Rolle mehr, aber das Recht KickMembers
    expect((await pm.check(kick, subject(IDS.mod))).allowed).toBe(true);
    expect(await pm.check(strict, subject(IDS.mod))).toMatchObject({ allowed: false, reason: 'level', required: 'mod' });
    expect((await pm.check(kick, subject(IDS.user))).allowed).toBe(false);
  });

  it('Owner-Befehle sind nur für Bot-Owner, auch Serverbesitzer nicht', async () => {
    const { pm } = setup();
    const c = cmd('shutdown', 'core', { level: 'owner' });
    expect((await pm.check(c, subject(IDS.owner))).allowed).toBe(false);
    expect((await pm.check(c, subject(IDS.botOwner))).allowed).toBe(true);
  });
});

describe('Regeln', () => {
  it('Verbot für einen Cog gilt für alle seine Befehle', async () => {
    const { pm } = setup();
    pm.setRule(IDS.guild, 'cog:trivia', `user:${IDS.user}`, false);
    expect(await pm.check(cmd('trivia', 'trivia'), subject(IDS.user))).toMatchObject({ allowed: false, reason: 'rule' });
    expect((await pm.check(cmd('trivia', 'trivia'), subject(IDS.mod))).allowed).toBe(true);
  });

  it('Befehlsregel schlägt Cog-Regel; Gruppenregel gilt für Unterbefehle', async () => {
    const { pm } = setup();
    pm.setRule(IDS.guild, 'cog:general', `guild:${IDS.guild}`, false);
    pm.setRule(IDS.guild, 'cmd:roll', `guild:${IDS.guild}`, true);
    expect((await pm.check(cmd('roll', 'general'), subject(IDS.user))).allowed).toBe(true);
    expect((await pm.check(cmd('flip', 'general'), subject(IDS.user))).allowed).toBe(false);

    const group = cmd('beispiel', 'example');
    const sub = cmd('beispiel seiten', 'example', undefined, group);
    pm.setRule(IDS.guild, 'cmd:beispiel', `user:${IDS.user}`, false);
    expect((await pm.check(sub, subject(IDS.user))).allowed).toBe(false);
  });

  it('Reihenfolge: Benutzer vor Kanal vor Kategorie vor Rolle vor Server', async () => {
    const { pm } = setup();
    const c = cmd('ping', 'core');
    pm.setRule(IDS.guild, 'cmd:ping', `guild:${IDS.guild}`, false);
    expect((await pm.check(c, subject(IDS.user))).allowed).toBe(false);
    pm.setRule(IDS.guild, 'cmd:ping', `role:${IDS.roleMember}`, true);
    expect((await pm.check(c, subject(IDS.user))).allowed).toBe(true);
    pm.setRule(IDS.guild, 'cmd:ping', `channel:${IDS.category}`, false);
    expect((await pm.check(c, subject(IDS.user))).allowed).toBe(false);
    pm.setRule(IDS.guild, 'cmd:ping', `channel:${IDS.channel}`, true);
    expect((await pm.check(c, subject(IDS.user))).allowed).toBe(true);
    pm.setRule(IDS.guild, 'cmd:ping', `user:${IDS.user}`, false);
    expect((await pm.check(c, subject(IDS.user))).allowed).toBe(false);
  });

  it('höchste Rolle gewinnt bei widersprüchlichen Rollenregeln', async () => {
    const { pm } = setup();
    const c = cmd('ping', 'core');
    pm.setRule(IDS.guild, 'cmd:ping', `role:${IDS.roleMember}`, false); // Position 1
    pm.setRule(IDS.guild, 'cmd:ping', `role:${IDS.roleMod}`, true); // Position 2
    expect((await pm.check(c, subject(IDS.mod))).allowed).toBe(true);
    expect((await pm.check(c, subject(IDS.user))).allowed).toBe(false);
  });

  it('Voice-Kanal-Regeln greifen, wenn der User im Voice-Kanal ist', async () => {
    const { pm } = setup();
    pm.setRule(IDS.guild, 'cog:audio', `channel:${IDS.voice}`, false);
    expect((await pm.check(cmd('play', 'audio'), subject(IDS.user, { voiceChannelId: IDS.voice }))).allowed).toBe(false);
    expect((await pm.check(cmd('play', 'audio'), subject(IDS.user))).allowed).toBe(true);
  });

  it('globale Regeln haben Vorrang vor Server-Regeln', async () => {
    const { pm } = setup();
    pm.setRule('global', 'cog:economy', `user:${IDS.user}`, false);
    pm.setRule(IDS.guild, 'cog:economy', `user:${IDS.user}`, true);
    expect((await pm.check(cmd('balance', 'economy'), subject(IDS.user))).allowed).toBe(false);
  });

  it('Erlauben-Regel hebt Stufe auf – aber nicht für owner/guildowner-Befehle', async () => {
    const { pm } = setup();
    const modCmd = cmd('cleanup', 'cleanup', { level: 'mod' });
    const ownerCmd = cmd('load', 'core', { level: 'owner' });
    pm.setRule(IDS.guild, 'cmd:cleanup', `user:${IDS.user}`, true);
    pm.setRule(IDS.guild, 'cmd:load', `user:${IDS.user}`, true);
    expect(await pm.check(modCmd, subject(IDS.user))).toMatchObject({ allowed: true, via: 'rule' });
    expect((await pm.check(ownerCmd, subject(IDS.user))).allowed).toBe(false);
  });

  it('Standard-Regeln greifen nur, wenn keine spezifische Regel passt', async () => {
    const { pm } = setup();
    pm.setRule(IDS.guild, 'cog:economy', 'default', false);
    pm.setRule(IDS.guild, 'cog:economy', `channel:${IDS.channel2}`, true);
    expect((await pm.check(cmd('balance', 'economy'), subject(IDS.user))).allowed).toBe(false);
    expect((await pm.check(cmd('balance', 'economy'), subject(IDS.user, { channelId: IDS.channel2 }))).allowed).toBe(true);
  });

  it('Bot-Owner sind von Verboten ausgenommen', async () => {
    const { pm } = setup();
    pm.setRule('global', 'cog:core', `user:${IDS.botOwner}`, false);
    expect((await pm.check(cmd('ping', 'core'), subject(IDS.botOwner))).allowed).toBe(true);
  });

  it('Regeln verwalten: entfernen, auflisten, löschen', () => {
    const { pm } = setup();
    pm.setRule(IDS.guild, 'cog:a', 'default', true);
    pm.setRule(IDS.guild, 'cog:a', 'default', false); // überschreibt
    pm.setRule(IDS.guild, 'cmd:b', `user:${IDS.user}`, true);
    pm.setRule('global', 'cmd:c', `user:${IDS.user}`, true);
    expect(pm.listRules(IDS.guild)).toHaveLength(2);
    expect(pm.listRules(IDS.guild).find((r) => r.model === 'cog:a')?.allow).toBe(false);
    expect(pm.removeRule(IDS.guild, 'cmd:b', `user:${IDS.user}`)).toBe(true);
    expect(pm.removeRule(IDS.guild, 'cmd:b', `user:${IDS.user}`)).toBe(false);
    expect(pm.clearRules(IDS.guild)).toBe(1);
    expect(pm.listRules('global')).toHaveLength(1);
  });
});

describe('Rechteberechnung (Bits)', () => {
  it('Serverbesitzer und Administrator haben alle Rechte', () => {
    const g = guild();
    expect(hasPermissions(computeBasePermissions(g, { roles: [], user: { id: IDS.owner } }), ['BanMembers'])).toBe(true);
    expect(hasPermissions(computeBasePermissions(g, { roles: [IDS.roleAdmin], user: { id: IDS.admin } }), ['MoveMembers'])).toBe(true);
    expect(hasPermissions(computeBasePermissions(g, { roles: [IDS.roleMember], user: { id: IDS.user } }), ['KickMembers'])).toBe(false);
  });

  it('Kanal-Overwrites: @everyone → Rollen → Mitglied', () => {
    const g = guild();
    const member = { roles: [IDS.roleMember], user: { id: IDS.user } };
    const channel = {
      permission_overwrites: [
        { id: IDS.guild, type: 0, allow: '0', deny: F.SendMessages.toString() },
        { id: IDS.roleMember, type: 0, allow: F.SendMessages.toString(), deny: '0' },
        { id: IDS.user, type: 1, allow: '0', deny: F.ViewChannel.toString() },
      ],
    } as never;
    const bits = computeChannelPermissions(g, member, channel);
    expect((bits & F.SendMessages) !== 0n).toBe(true);
    expect((bits & F.ViewChannel) !== 0n).toBe(false);
    const other = computeChannelPermissions(g, { roles: [], user: { id: '1' } }, channel);
    expect((other & F.SendMessages) !== 0n).toBe(false);
  });
});
