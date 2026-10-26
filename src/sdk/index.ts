/**
 * Öffentliche API für Cogs: `import { defineCog, OptionType } from '@bot/sdk';`
 *
 * Dieses Modul ist bewusst zustandslos (nur Typen, Konstanten und reine Funktionen):
 * Der Cog-Loader bündelt es in jeden Cog hinein. Alles mit Zustand (Config, Bot, Plattform)
 * bekommt der Cog über das `cog`-Objekt in `setup(cog)`.
 */
import type { Cog } from '../cogs/cog.js';

export type { Cog } from '../cogs/cog.js';
export type { CommandContext } from '../commands/context.js';
export type { Bot } from '../bot.js';
export type { FluxerPlatform } from '../platform/platform.js';
export type { Config, ScopedConfig } from '../config/config.js';
export type { TaskSpec } from '../scheduler/scheduler.js';
export type { Translator, Vars } from '../i18n/i18n.js';
export type { ResolvedUser, ResolvedMentionable } from '../commands/parser.js';
export type { ReactionEvent, Page } from '../utils/menus.js';
export type * from '../platform/types.js';

export {
  OptionType,
  type CommandDefinition,
  type CommandOption,
  type CommandPermissions,
  type CooldownSpec,
  type PermissionLevel,
  type OptionChoice,
} from '../commands/types.js';
export { CommandError, UserError, ArgumentError, CheckFailure } from '../commands/errors.js';
export { embed, embedToText, Colors, type EmbedInput } from '../utils/embeds.js';
export {
  bold,
  italic,
  inlineCode,
  codeBlock,
  escape,
  pagify,
  humanList,
  humanizeSeconds,
  parseDuration,
  formatDateTime,
  formatNumber,
} from '../utils/format.js';
export { PermissionFlags, PermissionLabels, hasPermissions, type PermissionName } from '../platform/permissionBits.js';
export { NUMBER_EMOJIS, EMOJI, sameEmoji } from '../utils/menus.js';
export { VoiceUnsupportedError, VOICE_CAPABILITIES } from '../platform/voice.js';
export { resolveUser, resolveRole, resolveChannel, tokenize, usageOf, type ParseEnvironment } from '../commands/parser.js';

/** Inhalt von manifest.json eines Cogs. */
export interface CogManifest {
  /** Eindeutiger Name (= Ordnername, Kleinbuchstaben). */
  name: string;
  version: string;
  author: string | string[];
  description: string;
  /** Andere Cogs, die vorher geladen sein müssen. */
  dependencies?: string[];
  /** npm-Pakete, die der Downloader beim Installieren nachinstalliert. */
  npmDependencies?: Record<string, string>;
  /** Anzeigename/Kategorie in der Hilfe. */
  displayName?: string;
  /** Hinweis, welche Nutzerdaten der Cog speichert (wie Reds end_user_data_statement). */
  endUserData?: string;
  /** Mindestversion des Bots. */
  minBotVersion?: string;
  /** In `!cogs` und der Hilfe ausblenden. */
  hidden?: boolean;
  tags?: string[];
}

export interface CogDefinition {
  /** Wird beim Laden aufgerufen: Config-Defaults, Befehle, Listener und Tasks registrieren. */
  setup(cog: Cog): void | Promise<void>;
  /** Wird beim Entladen aufgerufen (Ressourcen freigeben). Listener/Tasks/Befehle räumt der Loader selbst ab. */
  teardown?(cog: Cog): void | Promise<void>;
}

/** Markiert die Cog-Definition (für Typprüfung und Erkennung durch den Loader). */
export function defineCog(definition: CogDefinition | ((cog: Cog) => void | Promise<void>)): CogDefinition {
  return typeof definition === 'function' ? { setup: definition } : definition;
}
