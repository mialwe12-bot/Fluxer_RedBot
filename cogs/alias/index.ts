import { defineCog, embed, OptionType, pagify, UserError, type APIMessage, type Cog, type CommandContext } from '@bot/sdk';

interface Alias {
  command: string;
  creator: string;
  uses: number;
}

/** Event des Dispatchers für unbekannte Befehle. */
interface CommandNotFoundEvent {
  message: APIMessage & { __aliasDepth?: number };
  prefix: string;
  text: string;
  handled: boolean;
}

const NAME_RE = /^[\p{L}\p{N}_-]{1,32}$/u;
const MAX_DEPTH = 5;

export default defineCog({
  setup(cog: Cog) {
    cog.config.registerGuild({ aliases: {} as Record<string, Alias> });
    cog.config.registerGlobal({ aliases: {} as Record<string, Alias> });

    cog.on('commandNotFound', async (event: CommandNotFoundEvent) => {
      if (event.handled) return;
      const m = /^(\S+)([\s\S]*)$/.exec(event.text);
      if (!m) return;
      const name = m[1]!.toLowerCase();
      const guildId = event.message.guild_id ?? undefined;
      const local = guildId ? cog.config.guild(guildId).get<Record<string, Alias>>('aliases')[name] : undefined;
      const alias = local ?? cog.config.global().get<Record<string, Alias>>('aliases')[name];
      if (!alias) return;
      const depth = (event.message.__aliasDepth ?? 0) + 1;
      if (depth > MAX_DEPTH) return;
      event.handled = true;
      const prefix = event.prefix.startsWith('<@') ? (cog.bot.prefixesFor(guildId)[0] ?? '!') : event.prefix;
      const message = { ...event.message, content: `${prefix}${alias.command}${m[2] ?? ''}`, __aliasDepth: depth };
      const conf = local && guildId ? cog.config.guild(guildId) : cog.config.global();
      conf.update<Record<string, Alias>>('aliases', (all) => (all[name] ? { ...all, [name]: { ...all[name]!, uses: all[name]!.uses + 1 } } : all));
      await cog.bot.dispatcher.handleMessage(message);
    });

    const validate = (ctx: CommandContext, name: string, command: string) => {
      if (!NAME_RE.test(name)) throw new UserError(ctx.t('badName'));
      if (ctx.bot.registry.get(name)) throw new UserError(ctx.t('isCommand', { name }));
      const cleaned = command.replace(new RegExp(`^(${ctx.bot.prefixesFor(ctx.guildId).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`), '').trim();
      const first = cleaned.split(/\s+/)[0] ?? '';
      if (!ctx.bot.registry.get(first) && !aliasExists(ctx, first)) throw new UserError(ctx.t('unknownCommand', { command: first }));
      return cleaned;
    };
    const aliasExists = (ctx: CommandContext, name: string) =>
      Boolean((ctx.guildId && cog.config.guild(ctx.guildId).get<Record<string, Alias>>('aliases')[name]) || cog.config.global().get<Record<string, Alias>>('aliases')[name]);

    const nameOpt = { name: 'name', description: 'Name des Alias', type: OptionType.String, required: true } as const;
    const cmdOpt = { name: 'befehl', description: 'Befehl mit Argumenten (ohne Prefix)', type: OptionType.String, required: true, rest: true } as const;

    const listAliases = async (ctx: CommandContext, all: Record<string, Alias>, title: string) => {
      const entries = Object.entries(all).sort(([a], [b]) => a.localeCompare(b));
      if (!entries.length) return ctx.reply(ctx.t('none'));
      const lines = entries.map(([n, a]) => `\`${ctx.prefix}${n}\` → \`${a.command}\``);
      await ctx.paginate(pagify(lines.join('\n'), { pageLength: 1800 }).map((pg) => embed({ title, description: pg })));
    };

    cog.group({
      name: 'alias',
      description: 'Aliase verwalten.',
      subcommands: [
        {
          name: 'add',
          description: 'Legt einen Alias für diesen Server an.',
          aliases: ['create'],
          guildOnly: true,
          permissions: { level: 'mod', member: ['ManageGuild'] },
          options: [nameOpt, cmdOpt],
          examples: ['alias add b ban', 'alias add regeln help general'],
          run: async (ctx) => {
            const name = ctx.arg<string>('name').toLowerCase();
            const command = validate(ctx, name, ctx.arg<string>('befehl'));
            const conf = cog.config.guild(ctx.guildId!);
            if (conf.get<Record<string, Alias>>('aliases')[name]) throw new UserError(ctx.t('exists', { name }));
            conf.update<Record<string, Alias>>('aliases', (all) => ({ ...all, [name]: { command, creator: ctx.author.id, uses: 0 } }));
            await ctx.reply(ctx.t('added', { name: `${ctx.prefix}${name}`, command }));
          },
        },
        {
          name: 'delete',
          description: 'Löscht einen Server-Alias.',
          aliases: ['del', 'remove'],
          guildOnly: true,
          permissions: { level: 'mod', member: ['ManageGuild'] },
          options: [nameOpt],
          run: async (ctx) => {
            const name = ctx.arg<string>('name').toLowerCase();
            let found = false;
            cog.config.guild(ctx.guildId!).update<Record<string, Alias>>('aliases', (all) => {
              found = name in all;
              const { [name]: _gone, ...rest } = all;
              return rest;
            });
            if (!found) throw new UserError(ctx.t('notFound', { name }));
            await ctx.reply(ctx.t('deleted', { name }));
          },
        },
        {
          name: 'list',
          description: 'Aliase dieses Servers.',
          guildOnly: true,
          run: (ctx) => listAliases(ctx, cog.config.guild(ctx.guildId!).get<Record<string, Alias>>('aliases'), ctx.t('listTitle')),
        },
        {
          name: 'show',
          description: 'Zeigt, wofür ein Alias steht.',
          options: [nameOpt],
          run: async (ctx) => {
            const name = ctx.arg<string>('name').toLowerCase();
            const a =
              (ctx.guildId ? cog.config.guild(ctx.guildId).get<Record<string, Alias>>('aliases')[name] : undefined) ??
              cog.config.global().get<Record<string, Alias>>('aliases')[name];
            if (!a) throw new UserError(ctx.t('notFound', { name }));
            await ctx.reply(ctx.t('show', { name: `${ctx.prefix}${name}`, command: a.command, uses: a.uses, creator: `<@${a.creator}>` }));
          },
        },
        {
          name: 'global',
          description: 'Globale Aliase (für alle Server).',
          permissions: { level: 'owner' },
          subcommands: [
            {
              name: 'add',
              description: 'Legt einen globalen Alias an.',
              options: [nameOpt, cmdOpt],
              run: async (ctx) => {
                const name = ctx.arg<string>('name').toLowerCase();
                const command = validate(ctx, name, ctx.arg<string>('befehl'));
                cog.config.global().update<Record<string, Alias>>('aliases', (all) => ({ ...all, [name]: { command, creator: ctx.author.id, uses: 0 } }));
                await ctx.reply(ctx.t('added', { name: `${ctx.prefix}${name}`, command }));
              },
            },
            {
              name: 'delete',
              description: 'Löscht einen globalen Alias.',
              aliases: ['del', 'remove'],
              options: [nameOpt],
              run: async (ctx) => {
                const name = ctx.arg<string>('name').toLowerCase();
                cog.config.global().update<Record<string, Alias>>('aliases', (all) => {
                  const { [name]: _gone, ...rest } = all;
                  return rest;
                });
                await ctx.reply(ctx.t('deleted', { name }));
              },
            },
            {
              name: 'list',
              description: 'Globale Aliase.',
              run: (ctx) => listAliases(ctx, cog.config.global().get<Record<string, Alias>>('aliases'), ctx.t('globalListTitle')),
            },
          ],
        },
      ],
    });
  },
});
