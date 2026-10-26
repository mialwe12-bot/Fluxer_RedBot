import type { APIChannel, APIGuildMember, APIRole } from '@fluxerjs/types';

/** Fluxer-Berechtigungsbits (identisch mit @fluxerjs/util, Discord-kompatible Positionen). */
export const PermissionFlags = {
  CreateInstantInvite: 1n << 0n,
  KickMembers: 1n << 1n,
  BanMembers: 1n << 2n,
  Administrator: 1n << 3n,
  ManageChannels: 1n << 4n,
  ManageGuild: 1n << 5n,
  AddReactions: 1n << 6n,
  ViewAuditLog: 1n << 7n,
  PrioritySpeaker: 1n << 8n,
  Stream: 1n << 9n,
  ViewChannel: 1n << 10n,
  SendMessages: 1n << 11n,
  SendTtsMessages: 1n << 12n,
  ManageMessages: 1n << 13n,
  EmbedLinks: 1n << 14n,
  AttachFiles: 1n << 15n,
  ReadMessageHistory: 1n << 16n,
  MentionEveryone: 1n << 17n,
  UseExternalEmojis: 1n << 18n,
  Connect: 1n << 20n,
  Speak: 1n << 21n,
  MuteMembers: 1n << 22n,
  DeafenMembers: 1n << 23n,
  MoveMembers: 1n << 24n,
  UseVad: 1n << 25n,
  ChangeNickname: 1n << 26n,
  ManageNicknames: 1n << 27n,
  ManageRoles: 1n << 28n,
  ManageWebhooks: 1n << 29n,
  ManageExpressions: 1n << 30n,
  UseExternalStickers: 1n << 37n,
  ModerateMembers: 1n << 40n,
  CreateExpressions: 1n << 43n,
  PinMessages: 1n << 51n,
  BypassSlowmode: 1n << 52n,
  UpdateRtcRegion: 1n << 53n,
  ViewChannelMembers: 1n << 54n,
} as const;

export type PermissionName = keyof typeof PermissionFlags;

export const ALL_PERMISSIONS = Object.values(PermissionFlags).reduce((a, b) => a | b, 0n);

/** Deutsche Anzeigenamen für Fehlermeldungen. */
export const PermissionLabels: Record<PermissionName, string> = {
  CreateInstantInvite: 'Einladungen erstellen',
  KickMembers: 'Mitglieder kicken',
  BanMembers: 'Mitglieder bannen',
  Administrator: 'Administrator',
  ManageChannels: 'Kanäle verwalten',
  ManageGuild: 'Server verwalten',
  AddReactions: 'Reaktionen hinzufügen',
  ViewAuditLog: 'Audit-Log ansehen',
  PrioritySpeaker: 'Prioritätssprecher',
  Stream: 'Streamen',
  ViewChannel: 'Kanal ansehen',
  SendMessages: 'Nachrichten senden',
  SendTtsMessages: 'TTS-Nachrichten senden',
  ManageMessages: 'Nachrichten verwalten',
  EmbedLinks: 'Links einbetten',
  AttachFiles: 'Dateien anhängen',
  ReadMessageHistory: 'Nachrichtenverlauf lesen',
  MentionEveryone: '@everyone erwähnen',
  UseExternalEmojis: 'Externe Emojis verwenden',
  Connect: 'Verbinden',
  Speak: 'Sprechen',
  MuteMembers: 'Mitglieder stummschalten',
  DeafenMembers: 'Mitglieder taub schalten',
  MoveMembers: 'Mitglieder verschieben',
  UseVad: 'Sprachaktivierung verwenden',
  ChangeNickname: 'Nickname ändern',
  ManageNicknames: 'Nicknames verwalten',
  ManageRoles: 'Rollen verwalten',
  ManageWebhooks: 'Webhooks verwalten',
  ManageExpressions: 'Emojis & Sticker verwalten',
  UseExternalStickers: 'Externe Sticker verwenden',
  ModerateMembers: 'Mitglieder moderieren (Timeout)',
  CreateExpressions: 'Emojis & Sticker erstellen',
  PinMessages: 'Nachrichten anpinnen',
  BypassSlowmode: 'Slowmode umgehen',
  UpdateRtcRegion: 'Sprachregion ändern',
  ViewChannelMembers: 'Kanalmitglieder ansehen',
};

export function permissionsToBits(names: readonly PermissionName[]): bigint {
  return names.reduce((acc, n) => acc | PermissionFlags[n], 0n);
}

export function hasPermissions(bits: bigint, names: readonly PermissionName[]): boolean {
  if ((bits & PermissionFlags.Administrator) !== 0n) return true;
  return names.every((n) => (bits & PermissionFlags[n]) !== 0n);
}

export function missingPermissions(bits: bigint, names: readonly PermissionName[]): PermissionName[] {
  if ((bits & PermissionFlags.Administrator) !== 0n) return [];
  return names.filter((n) => (bits & PermissionFlags[n]) === 0n);
}

export interface GuildLike {
  id: string;
  owner_id: string;
  roles: Map<string, APIRole>;
}

/** Server-weite Rechte eines Mitglieds (nur Rollen, ohne Kanal-Overwrites). */
export function computeBasePermissions(guild: GuildLike, member: Pick<APIGuildMember, 'roles'> & { user: { id: string } }): bigint {
  if (member.user.id === guild.owner_id) return ALL_PERMISSIONS;
  const everyone = guild.roles.get(guild.id);
  let bits = everyone ? BigInt(everyone.permissions) : 0n;
  for (const roleId of member.roles) {
    const role = guild.roles.get(roleId);
    if (role) bits |= BigInt(role.permissions);
  }
  if ((bits & PermissionFlags.Administrator) !== 0n) return ALL_PERMISSIONS;
  return bits;
}

/** Effektive Rechte in einem Kanal (Discord-Algorithmus: @everyone → Rollen → Mitglied). */
export function computeChannelPermissions(
  guild: GuildLike,
  member: Pick<APIGuildMember, 'roles'> & { user: { id: string } },
  channel: Pick<APIChannel, 'permission_overwrites'> | undefined,
): bigint {
  let bits = computeBasePermissions(guild, member);
  if ((bits & PermissionFlags.Administrator) !== 0n) return ALL_PERMISSIONS;
  const overwrites = channel?.permission_overwrites ?? [];
  const everyone = overwrites.find((o) => o.id === guild.id);
  if (everyone) {
    bits &= ~BigInt(everyone.deny);
    bits |= BigInt(everyone.allow);
  }
  let allow = 0n;
  let deny = 0n;
  for (const o of overwrites) {
    if (Number(o.type) === 0 && member.roles.includes(o.id)) {
      allow |= BigInt(o.allow);
      deny |= BigInt(o.deny);
    }
  }
  bits &= ~deny;
  bits |= allow;
  const own = overwrites.find((o) => Number(o.type) === 1 && o.id === member.user.id);
  if (own) {
    bits &= ~BigInt(own.deny);
    bits |= BigInt(own.allow);
  }
  return bits;
}
