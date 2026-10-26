import {
  defineCog,
  OptionType,
  resolveChannel,
  resolveRole,
  resolveUser,
  UserError,
  pagify,
  embed,
  type CommandContext,
  type CommandDefinition,
  type ParseEnvironment,
  type ResolvedUser,
} from '@bot/sdk';

/**
 * Permissions-Cog (wie Reds Permissions): verwaltet Erlauben/Verbieten-Regeln.
 * Die Auswertung selbst steckt im Kern (src/permissions/permissions.ts).
 *
 * Reihenfolge der Auswertung: globale Regeln vor Server-Regeln; Befehl vor Elterngruppe vor Cog;
 * je Regel-Ziel: Benutzer → Voice-Kanal → Kanal → Kategorie → Rollen (höchste zuerst) → Server;
 * zuletzt Standard-Regeln. Bot-Owner sind von Regeln ausgenommen.
 */

type Model = `cog:${string}` | `cmd:${string}`;
type Subject = `user:${string}` | `role:${string}` | `channel:${string}` | `guild:${string}`;

const ALLOW_DENY = [
  { name: 'allow', value: 'allow' },
  { name: 'erlauben', value: 'allow' },
  { name: 'deny', value: 'deny' },
  { name: 'verbieten', value: 'deny' },
];

function env(ctx: CommandContext): ParseEnvironment {
  return { guild: ctx.guild, users: ctx.bot.platform.users, attachments: [] };
}

/** "cog:name", "cmd:set name", Cog-Name oder Befehlsname → Model. */
function resolveModel(ctx: CommandContext, raw: string): { model: Model; label: string } {
  const text = raw.trim().toLowerCase();
  if (text.startsWith('cmd:') || text.startsWith('befehl:')) {
    const cmd = ctx.bot.registry.find(text.replace(/^(cmd|befehl):/, ''));
    if (!cmd) throw new UserError(ctx.t('errors.unknownTarget', { target: raw }));
    return { model: `cmd:${cmd.qualifiedName}`, label: ctx.t('labels.command', { name: cmd.qualifiedName }) };
  }
  const cogName = text.replace(/^cog:/, '');
  const available = ctx.bot.cogs.discover();
  const cog = ctx.bot.cogs.loaded.get(cogName) ?? (available.has(cogName) ? { name: cogName } : undefined);
  if (cog || text.startsWith('cog:')) {
    if (!cog) throw new UserError(ctx.t('errors.unknownTarget', { target: raw }));
    return { model: `cog:${cog.name}`, label: ctx.t('labels.cog', { name: cog.name }) };
  }
  const cmd = ctx.bot.registry.find(text);
  if (!cmd) throw new UserError(ctx.t('errors.unknownTarget', { target: raw }));
  return { model: `cmd:${cmd.qualifiedName}`, label: ctx.t('labels.command', { name: cmd.qualifiedName }) };
}

/** "@user", "@&rolle", "#kanal", IDs, Namen oder "server"/"everyone" → Subject. */
function resolveSubject(ctx: CommandContext, raw: string): { subject: Subject; label: string } {
  const text = raw.trim();
  const lower = text.toLowerCase();
  if (['server', 'guild', 'everyone', '@everyone', 'alle', 'jeder'].includes(lower)) {
    if (!ctx.guildId) throw new UserError(ctx.t('errors.serverInDm'));
    return { subject: `guild:${ctx.guildId}`, label: ctx.t('labels.server') };
  }
  const e = env(ctx);
  if (/^<#\d+>$/.test(text) || text.startsWith('#')) {
    const ch = resolveChannel(text, e);
    if (ch) return { subject: `channel:${ch.id}`, label: `#${ch.name}` };
  }
  if (/^<@&\d+>$/.test(text)) {
    const role = resolveRole(text, e);
    if (role) return { subject: `role:${role.id}`, label: `@${role.name}` };
  }
  if (/^<@!?\d+>$/.test(text)) {
    const user = resolveUser(text, e);
    if (user) return { subject: `user:${user.id}`, label: `<@${user.id}>` };
  }
  if (/^\d{15,21}$/.test(text)) {
    const g = ctx.guild;
    if (g?.roles.has(text)) return { subject: `role:${text}`, label: `@${g.roles.get(text)!.name}` };
    if (g?.channels.has(text)) return { subject: `channel:${text}`, label: `#${g.channels.get(text)!.name}` };
    if (ctx.bot.platform.guilds.has(text)) return { subject: `guild:${text}`, label: ctx.bot.platform.guilds.get(text)!.name };
    return { subject: `user:${text}`, label: `<@${text}>` };
  }
  const user = resolveUser(text, e);
  if (user) return { subject: `user:${user.id}`, label: `<@${user.id}>` };
  const role = resolveRole(text, e);
  if (role) return { subject: `role:${role.id}`, label: `@${role.name}` };
  const ch = resolveChannel(text, e);
  if (ch) return { subject: `channel:${ch.id}`, label: `#${ch.name}` };
  throw new UserError(ctx.t('errors.unknownSubject', { who: raw }));
}

function describeSubject(ctx: CommandContext, subject: string): string {
  const [kind, id] = subject.split(':') as [string, string | undefined];
  const g = ctx.guild;
  switch (kind) {
    case 'user':
      return `<@${id}>`;
    case 'role':
      return `@${g?.roles.get(id!)?.name ?? id}`;
    case 'channel':
      return `#${g?.channels.get(id!)?.name ?? id}`;
    case 'guild':
      return ctx.bot.platform.guilds.get(id!)?.name ?? `Server ${id}`;
    default:
      return ctx.t('labels.default');
  }
}

function ruleCommands(scope: 'global' | 'server'): CommandDefinition[] {
  const isGlobal = scope === 'global';
  const permissions = isGlobal
    ? ({ level: 'owner' } as const)
    : ({ level: 'guildowner', member: ['Administrator'] } as const);
  const scopeId = (ctx: CommandContext) => (isGlobal ? 'global' : ctx.guildId!);
  const suffix = isGlobal ? 'globalrule' : 'serverrule';
  return [
    {
      name: `add${suffix}`,
      description: isGlobal ? 'Fügt eine globale Regel hinzu.' : 'Fügt eine Regel für diesen Server hinzu.',
      guildOnly: !isGlobal,
      permissions,
      options: [
        { name: 'aktion', description: 'allow/erlauben oder deny/verbieten', type: OptionType.String, required: true, choices: ALLOW_DENY },
        { name: 'wer', description: 'Benutzer, Rolle, Kanal oder "server"', type: OptionType.String, required: true },
        { name: 'ziel', description: 'Cog oder Befehl (z. B. "mod" oder "cmd:set name")', type: OptionType.String, required: true, rest: true },
      ],
      examples: [`add${suffix} deny #allgemein trivia`, `add${suffix} allow @Helfer cmd:cleanup`],
      run: async (ctx) => {
        const allow = ctx.arg<string>('aktion') === 'allow';
        const { subject, label: who } = resolveSubject(ctx, ctx.arg<string>('wer'));
        const { model, label: target } = resolveModel(ctx, ctx.arg<string>('ziel'));
        ctx.bot.permissions.setRule(scopeId(ctx), model, subject, allow);
        await ctx.reply(ctx.t(allow ? 'rules.addedAllow' : 'rules.addedDeny', { who, target, scope: ctx.t(`scope.${scope}`) }));
      },
    },
    {
      name: `remove${suffix}`,
      description: isGlobal ? 'Entfernt eine globale Regel.' : 'Entfernt eine Regel dieses Servers.',
      guildOnly: !isGlobal,
      permissions,
      options: [
        { name: 'wer', description: 'Benutzer, Rolle, Kanal oder "server"', type: OptionType.String, required: true },
        { name: 'ziel', description: 'Cog oder Befehl', type: OptionType.String, required: true, rest: true },
      ],
      run: async (ctx) => {
        const { subject, label: who } = resolveSubject(ctx, ctx.arg<string>('wer'));
        const { model, label: target } = resolveModel(ctx, ctx.arg<string>('ziel'));
        const removed = ctx.bot.permissions.removeRule(scopeId(ctx), model, subject);
        await ctx.reply(ctx.t(removed ? 'rules.removed' : 'rules.notFound', { who, target }));
      },
    },
    {
      name: `setdefault${suffix}`,
      description: isGlobal ? 'Standard-Regel (global) für einen Cog/Befehl.' : 'Standard-Regel (Server) für einen Cog/Befehl.',
      guildOnly: !isGlobal,
      permissions,
      options: [
        {
          name: 'aktion',
          description: 'allow, deny oder clear',
          type: OptionType.String,
          required: true,
          choices: [...ALLOW_DENY, { name: 'clear', value: 'clear' }, { name: 'entfernen', value: 'clear' }],
        },
        { name: 'ziel', description: 'Cog oder Befehl', type: OptionType.String, required: true, rest: true },
      ],
      run: async (ctx) => {
        const action = ctx.arg<string>('aktion');
        const { model, label: target } = resolveModel(ctx, ctx.arg<string>('ziel'));
        if (action === 'clear') {
          ctx.bot.permissions.removeRule(scopeId(ctx), model, 'default');
          return ctx.reply(ctx.t('rules.defaultCleared', { target }));
        }
        ctx.bot.permissions.setRule(scopeId(ctx), model, 'default', action === 'allow');
        await ctx.reply(ctx.t(action === 'allow' ? 'rules.defaultAllow' : 'rules.defaultDeny', { target }));
      },
    },
    {
      name: `clear${suffix}s`,
      description: isGlobal ? 'Löscht alle globalen Regeln.' : 'Löscht alle Regeln dieses Servers.',
      guildOnly: !isGlobal,
      permissions,
      run: async (ctx) => {
        const ok = await ctx.confirm(ctx.t('rules.clearConfirm', { scope: ctx.t(`scope.${scope}`) }));
        if (!ok) return ctx.reply(ctx.t('common.cancelled'));
        const n = ctx.bot.permissions.clearRules(scopeId(ctx));
        await ctx.reply(ctx.t('rules.cleared', { count: n }));
      },
    },
  ];
}

export default defineCog({
  setup(cog) {
    cog.group({
      name: 'permissions',
      description: cog.t('group'),
      aliases: ['perms', 'rechte'],
      subcommands: [
        {
          name: 'explain',
          description: cog.t('explain.description'),
          aliases: ['erklaerung'],
          run: async (ctx) => {
            await ctx.paginate(pagify(ctx.t('explain.text', { prefix: ctx.prefix }), { pageLength: 1900 }).map((p) => embed({ title: ctx.t('explain.title'), description: p })));
          },
        },
        {
          name: 'list',
          description: cog.t('list.description'),
          aliases: ['show', 'liste'],
          options: [{ name: 'global', description: 'Globale statt Server-Regeln zeigen', type: OptionType.Boolean, default: false }],
          permissions: { level: 'admin', member: ['ManageGuild'] },
          run: async (ctx) => {
            const global = ctx.arg<boolean>('global') || !ctx.guildId;
            if (global && !ctx.bot.isOwner(ctx.author.id)) throw new UserError(ctx.t('errors.globalOwnerOnly'));
            const rules = ctx.bot.permissions.listRules(global ? 'global' : ctx.guildId!);
            if (!rules.length) return ctx.reply(ctx.t('list.empty'));
            const lines = rules.map(
              (r) => `${r.allow ? '✅' : '⛔'} \`${r.model.replace(/^cmd:/, '').replace(/^cog:/, 'Cog ')}\` → ${describeSubject(ctx, r.subject)}`,
            );
            const pages = pagify(lines.join('\n'), { pageLength: 1800 }).map((p) =>
              embed({ title: ctx.t(global ? 'list.titleGlobal' : 'list.titleServer'), description: p }),
            );
            await ctx.paginate(pages);
          },
        },
        {
          name: 'canrun',
          description: cog.t('canrun.description'),
          guildOnly: true,
          permissions: { level: 'admin', member: ['ManageGuild'] },
          options: [
            { name: 'user', description: 'Benutzer', type: OptionType.User, required: true },
            { name: 'befehl', description: 'Befehl', type: OptionType.String, required: true, rest: true },
          ],
          run: async (ctx) => {
            const user = ctx.arg<ResolvedUser>('user');
            const command = ctx.bot.registry.find(ctx.arg<string>('befehl'));
            if (!command) throw new UserError(ctx.t('errors.unknownTarget', { target: ctx.arg<string>('befehl') }));
            const channel = ctx.bot.platform.getChannel(ctx.channelId);
            const result = await ctx.bot.permissions.check(command, {
              userId: user.id,
              guildId: ctx.guildId,
              channelId: ctx.channelId,
              categoryId: channel?.parent_id ?? null,
              voiceChannelId: ctx.bot.platform.getVoiceState(ctx.guildId!, user.id)?.channel_id ?? null,
            });
            const key = result.allowed ? `canrun.yes.${result.via}` : `canrun.no.${result.reason}`;
            await ctx.reply(ctx.t(key, { user: `<@${user.id}>`, command: command.qualifiedName }));
          },
        },
        ...ruleCommands('global'),
        ...ruleCommands('server'),
      ],
    });
  },
});
