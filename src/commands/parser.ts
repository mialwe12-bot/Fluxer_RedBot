import type { APIChannel, APIGuildMember, APIRole, APIUser } from '../platform/types.js';
import type { CachedGuild } from '../platform/types.js';
import { ArgumentError } from './errors.js';
import { OptionType, type CommandOption, type ParsedArgs } from './types.js';

export interface Token {
  value: string;
  /** Startindex im Originalstring (inkl. Anführungszeichen). */
  start: number;
  end: number;
  quoted: boolean;
}

const QUOTES: Record<string, string> = { '"': '"', '„': '“', '“': '”', '«': '»', "'": "'" };

/** Zerlegt die Eingabe in Tokens; Anführungszeichen gruppieren ("…", „…“, '…'). */
export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    while (i < input.length && /\s/.test(input[i]!)) i++;
    if (i >= input.length) break;
    const start = i;
    const open = input[i]!;
    const close = QUOTES[open];
    if (close) {
      const endIdx = input.indexOf(close, i + 1);
      if (endIdx !== -1) {
        tokens.push({ value: input.slice(i + 1, endIdx), start, end: endIdx + 1, quoted: true });
        i = endIdx + 1;
        continue;
      }
    }
    while (i < input.length && !/\s/.test(input[i]!)) i++;
    tokens.push({ value: input.slice(start, i), start, end: i, quoted: false });
  }
  return tokens;
}

export interface ResolvedUser {
  id: string;
  user: APIUser | undefined;
  member: APIGuildMember | undefined;
}

export interface ResolvedMentionable {
  type: 'user' | 'role';
  id: string;
  user?: ResolvedUser;
  role?: APIRole;
}

export interface ParseEnvironment {
  guild: CachedGuild | undefined;
  /** Zusätzliche User-Quelle (z. B. Erwähnungen der Nachricht, globaler Cache). */
  users: Map<string, APIUser>;
  attachments: Array<{ id: string; filename: string; url: string; size?: number; content_type?: string | null }>;
}

const ID_RE = /^\d{15,21}$/;

function norm(s: string): string {
  return s.toLowerCase().normalize('NFKC');
}

export function resolveUser(raw: string, env: ParseEnvironment): ResolvedUser | undefined {
  const mention = /^<@!?(\d+)>$/.exec(raw);
  const id = mention?.[1] ?? (ID_RE.test(raw) ? raw : undefined);
  if (id) {
    return { id, user: env.users.get(id) ?? (env.guild?.members.get(id)?.user as APIUser | undefined), member: env.guild?.members.get(id) };
  }
  if (!env.guild) return undefined;
  const needle = norm(raw.replace(/^@/, ''));
  const members = [...env.guild.members.values()];
  const exact = members.find(
    (m) =>
      norm(m.user.username ?? '') === needle ||
      norm(`${m.user.username}#${(m.user as APIUser).discriminator ?? ''}`) === needle ||
      norm(m.nick ?? '') === needle ||
      norm((m.user as APIUser).global_name ?? '') === needle,
  );
  const found =
    exact ??
    members.find((m) => norm(m.user.username ?? '').startsWith(needle) || norm(m.nick ?? '').startsWith(needle));
  return found ? { id: found.user.id, user: found.user as APIUser, member: found } : undefined;
}

export function resolveRole(raw: string, env: ParseEnvironment): APIRole | undefined {
  if (!env.guild) return undefined;
  const mention = /^<@&(\d+)>$/.exec(raw);
  const id = mention?.[1] ?? (ID_RE.test(raw) ? raw : undefined);
  if (id) return env.guild.roles.get(id);
  const needle = norm(raw.replace(/^@/, ''));
  const roles = [...env.guild.roles.values()];
  return roles.find((r) => norm(r.name) === needle) ?? roles.find((r) => norm(r.name).startsWith(needle));
}

export function resolveChannel(raw: string, env: ParseEnvironment): APIChannel | undefined {
  if (!env.guild) return undefined;
  const mention = /^<#(\d+)>$/.exec(raw);
  const id = mention?.[1] ?? (ID_RE.test(raw) ? raw : undefined);
  if (id) return env.guild.channels.get(id);
  const needle = norm(raw.replace(/^#/, ''));
  const channels = [...env.guild.channels.values()];
  return channels.find((c) => norm(c.name ?? '') === needle) ?? channels.find((c) => norm(c.name ?? '').startsWith(needle));
}

const TRUE = new Set(['ja', 'j', 'yes', 'y', 'true', 'wahr', 'an', 'ein', 'on', '1', 'enable', 'aktiv', 'aktivieren']);
const FALSE = new Set(['nein', 'n', 'no', 'false', 'falsch', 'aus', 'off', '0', 'disable', 'inaktiv', 'deaktivieren']);

/** Wandelt einen einzelnen Rohwert in den Typ der Option um. Wirft ArgumentError. */
export function convertValue(option: CommandOption, raw: string, env: ParseEnvironment): unknown {
  const fail = (key: string, extra: Record<string, string | number> = {}): never => {
    throw new ArgumentError(key, { name: option.name, value: raw, ...extra });
  };
  let value: unknown;
  switch (option.type) {
    case OptionType.String: {
      if (option.min_length !== undefined && raw.length < option.min_length) fail('errors.args.minLength', { min: option.min_length });
      if (option.max_length !== undefined && raw.length > option.max_length) fail('errors.args.maxLength', { max: option.max_length });
      value = raw;
      break;
    }
    case OptionType.Integer:
    case OptionType.Number: {
      const n = Number(raw.replace(',', '.'));
      if (!Number.isFinite(n)) fail('errors.args.notNumber');
      if (option.type === OptionType.Integer && !Number.isInteger(n)) fail('errors.args.notInteger');
      if (option.min_value !== undefined && n < option.min_value) fail('errors.args.minValue', { min: option.min_value });
      if (option.max_value !== undefined && n > option.max_value) fail('errors.args.maxValue', { max: option.max_value });
      value = n;
      break;
    }
    case OptionType.Boolean: {
      const v = norm(raw);
      if (TRUE.has(v)) value = true;
      else if (FALSE.has(v)) value = false;
      else fail('errors.args.notBoolean');
      break;
    }
    case OptionType.User: {
      value = resolveUser(raw, env) ?? fail('errors.args.userNotFound');
      break;
    }
    case OptionType.Role: {
      value = resolveRole(raw, env) ?? fail('errors.args.roleNotFound');
      break;
    }
    case OptionType.Channel: {
      const ch = resolveChannel(raw, env) ?? fail('errors.args.channelNotFound');
      if (option.channel_types?.length && !option.channel_types.includes(Number((ch as APIChannel).type))) {
        fail('errors.args.channelType');
      }
      value = ch;
      break;
    }
    case OptionType.Mentionable: {
      const role = /^<@&\d+>$/.test(raw) ? resolveRole(raw, env) : undefined;
      if (role) value = { type: 'role', id: role.id, role } satisfies ResolvedMentionable;
      else {
        const user = resolveUser(raw, env);
        const r2 = user ? undefined : resolveRole(raw, env);
        if (user) value = { type: 'user', id: user.id, user } satisfies ResolvedMentionable;
        else if (r2) value = { type: 'role', id: r2.id, role: r2 } satisfies ResolvedMentionable;
        else fail('errors.args.mentionableNotFound');
      }
      break;
    }
    default:
      value = raw;
  }
  if (option.choices?.length) {
    const match = option.choices.find(
      (c) => norm(String(c.value)) === norm(String(value)) || norm(c.name) === norm(String(value)),
    );
    if (!match) fail('errors.args.choice', { choices: option.choices.map((c) => c.name).join(', ') });
    value = match!.value;
  }
  return value;
}

/**
 * Parst die Argumentzeichenkette anhand der Optionen.
 * - Optionen werden der Reihe nach belegt.
 * - `rest: true` (oder die letzte String-Option) nimmt den Rest der Eingabe roh auf.
 * - `variadic: true` sammelt alle restlichen Tokens als Array.
 * - Attachment-Optionen werden aus den Anhängen der Nachricht belegt, nicht aus dem Text.
 */
export function parseArgs(options: CommandOption[], input: string, env: ParseEnvironment): ParsedArgs {
  const tokens = tokenize(input);
  const result: ParsedArgs = {};
  let ti = 0;
  let attachmentIndex = 0;
  const textOptions = options.filter((o) => o.type !== OptionType.Attachment);
  const lastText = textOptions[textOptions.length - 1];

  for (const option of options) {
    if (option.type === OptionType.Attachment) {
      const att = env.attachments[attachmentIndex++];
      if (att) result[option.name] = att;
      else if (option.required) throw new ArgumentError('errors.args.missingAttachment', { name: option.name });
      else if (option.default !== undefined) result[option.name] = option.default;
      continue;
    }
    const token = tokens[ti];
    if (!token) {
      if (option.required) throw new ArgumentError('errors.args.missing', { name: option.name });
      if (option.default !== undefined) result[option.name] = option.default;
      continue;
    }
    if (option.variadic) {
      result[option.name] = tokens.slice(ti).map((t) => convertValue(option, t.value, env));
      ti = tokens.length;
      continue;
    }
    const greedy = option.rest || (option === lastText && option.type === OptionType.String && !option.choices);
    if (greedy) {
      const raw = tokens.length - ti === 1 ? token.value : input.slice(token.start).trim();
      result[option.name] = convertValue(option, raw, env);
      ti = tokens.length;
      continue;
    }
    result[option.name] = convertValue(option, token.value, env);
    ti++;
  }
  if (ti < tokens.length && textOptions.length > 0) {
    throw new ArgumentError('errors.args.tooMany', { extra: tokens.slice(ti).map((t) => t.value).join(' ') });
  }
  return result;
}

/** Verwendungszeile, z. B. "<user> [grund]" oder "<an|aus>". */
export function usageOf(options: CommandOption[] = []): string {
  return options
    .map((o) => {
      let label = o.choices?.length && o.choices.length <= 5 ? o.choices.map((c) => c.name).join('|') : o.name;
      if (o.variadic) label += '…';
      return o.required ? `<${label}>` : `[${label}]`;
    })
    .join(' ');
}
