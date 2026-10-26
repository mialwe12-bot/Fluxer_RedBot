import { permissionsToBits, type PermissionName } from '../platform/permissionBits.js';
import type { CommandContext } from './context.js';

/**
 * Command-Definitionen im Slash-Command-Format (Discord/Fluxer Application Commands),
 * damit später native Slash-Commands generiert werden können (siehe toApplicationCommand()).
 * Prefix-spezifische Erweiterungen (Aliase, Cooldowns, greedy-Argumente) liegen in eigenen Feldern.
 */
export enum OptionType {
  SubCommand = 1,
  SubCommandGroup = 2,
  String = 3,
  Integer = 4,
  Boolean = 5,
  User = 6,
  Channel = 7,
  Role = 8,
  Mentionable = 9,
  Number = 10,
  Attachment = 11,
}

export interface OptionChoice<T extends string | number = string | number> {
  name: string;
  value: T;
}

export interface CommandOption {
  name: string;
  description: string;
  type: OptionType;
  required?: boolean;
  choices?: OptionChoice[];
  min_value?: number;
  max_value?: number;
  min_length?: number;
  max_length?: number;
  /** Erlaubte Kanaltypen (ChannelType-Werte). */
  channel_types?: number[];
  /** Prefix-Erweiterung: Argument nimmt den gesamten Rest der Eingabe auf. */
  rest?: boolean;
  /** Prefix-Erweiterung: mehrere Werte (Leerzeichen-getrennt) bis zum Ende – Ergebnis ist ein Array. */
  variadic?: boolean;
  /** Prefix-Erweiterung: Default, wenn nicht angegeben. */
  default?: unknown;
}

/** Berechtigungsstufen wie bei Red. */
export type PermissionLevel = 'everyone' | 'mod' | 'admin' | 'guildowner' | 'owner';

export interface CommandPermissions {
  /** Mindeststufe. Default: 'everyone'. */
  level?: PermissionLevel;
  /**
   * Alternative zur Stufe (Red: mod_or_permissions): Wer diese Server-Rechte hat, darf auch.
   * Wird zugleich als default_member_permissions für spätere Slash-Commands genutzt.
   */
  member?: readonly PermissionName[];
  /** Rechte, die der Bot im Kanal braucht. */
  bot?: readonly PermissionName[];
}

export type CooldownBucket = 'user' | 'member' | 'channel' | 'guild' | 'global';

export interface CooldownSpec {
  /** Anzahl erlaubter Aufrufe … */
  rate: number;
  /** … pro so vielen Sekunden. */
  per: number;
  bucket?: CooldownBucket;
}

export type CommandHandler = (ctx: CommandContext) => unknown | Promise<unknown>;

/** Was ein Cog an `cog.command()` übergibt. */
export interface CommandDefinition {
  name: string;
  description: string;
  options?: CommandOption[];
  /** Unterbefehle; macht den Befehl zur Gruppe. */
  subcommands?: CommandDefinition[];
  aliases?: string[];
  cooldown?: CooldownSpec;
  permissions?: CommandPermissions;
  /** Nur in Servern nutzbar (nicht in DMs). Entspricht dm_permission = false. */
  guildOnly?: boolean;
  /** Nur in DMs nutzbar (Prefix-Erweiterung). */
  dmOnly?: boolean;
  /** In der Hilfe ausblenden. */
  hidden?: boolean;
  /** Ausführliche Hilfe (mehrzeilig). */
  help?: string;
  /** Beispiele für die Hilfe, ohne Prefix. */
  examples?: string[];
  /** Für Gruppen: wird ausgeführt, wenn kein Unterbefehl passt. Ohne run zeigt der Bot die Gruppenhilfe. */
  run?: CommandHandler;
}

/** Laufzeit-Repräsentation eines registrierten Befehls. */
export interface Command extends CommandDefinition {
  /** Voller Name inkl. Elterngruppen, z. B. "set name". */
  qualifiedName: string;
  cogName: string;
  parent?: Command;
  children: Map<string, Command>;
  /** Kategorie für die Hilfe (= Anzeigename des Cogs). */
  category: string;
}

/** Ergebnis des Argument-Parsers. */
export type ParsedArgs = Record<string, unknown>;

/** Erzeugt das native Application-Command-JSON (für spätere Slash-Command-Unterstützung). */
export function toApplicationCommand(cmd: CommandDefinition): Record<string, unknown> {
  const memberPerms = cmd.permissions?.member;
  const json: Record<string, unknown> = {
    name: cmd.name,
    description: cmd.description.slice(0, 100),
    type: 1,
    dm_permission: !cmd.guildOnly,
  };
  if (memberPerms?.length) json.default_member_permissions = permissionsToBits(memberPerms).toString();
  if (cmd.subcommands?.length) {
    json.options = cmd.subcommands.map((sub) =>
      sub.subcommands?.length
        ? {
            type: OptionType.SubCommandGroup,
            name: sub.name,
            description: sub.description.slice(0, 100),
            options: sub.subcommands.map((s) => ({
              type: OptionType.SubCommand,
              name: s.name,
              description: s.description.slice(0, 100),
              options: (s.options ?? []).map(stripOption),
            })),
          }
        : {
            type: OptionType.SubCommand,
            name: sub.name,
            description: sub.description.slice(0, 100),
            options: (sub.options ?? []).map(stripOption),
          },
    );
  } else {
    json.options = (cmd.options ?? []).map(stripOption);
  }
  return json;
}

function stripOption(o: CommandOption): Record<string, unknown> {
  const { rest: _rest, variadic: _variadic, default: _default, ...wire } = o;
  return { ...wire, description: o.description.slice(0, 100) };
}
