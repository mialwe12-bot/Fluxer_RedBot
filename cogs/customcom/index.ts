import { defineCog, embed, formatDateTime, OptionType, pagify, tokenize, UserError, type APIMessage, type Cog, type CommandContext } from '@bot/sdk';

interface CustomCommand {
  type: 'simple' | 'random';
  responses: string[];
  cooldowns: Partial<Record<'user' | 'channel' | 'server', number>>;
  author: string;
  createdAt: number;
  uses: number;
}

interface CommandNotFoundEvent {
  message: APIMessage;
  prefix: string;
  text: string;
  handled: boolean;
}

const NAME_RE = /^[\p{L}\p{N}_-]{1,32}$/u;

export interface TemplateContext {
  author: { id: string; username: string };
  channelId: string;
  channelName: string;
  serverName: string;
  args: string[];
  uses: number;
}

/**
 * Platzhalter wie bei Red: {author} {author.name} {author.id} {channel} {channel.name} {server}
 * {0} … {9} (Argumente), {args} (alle Argumente), {uses}.
 */
export function renderTemplate(template: string, c: TemplateContext): string {
  return template.replace(/\{(author(?:\.(?:name|id|mention))?|channel(?:\.(?:name|id|mention))?|server(?:\.name)?|args|uses|\d)\}/g, (_m, key: string) => {
    switch (key) {
      case 'author':
      case 'author.mention':
        return `<@${c.author.id}>`;
      case 'author.name':
        return c.author.username;
      case 'author.id':
        return c.author.id;
      case 'channel':
      case 'channel.mention':
        return `<#${c.channelId}>`;
      case 'channel.name':
        return c.channelName;
      case 'channel.id':
        return c.channelId;
      case 'server':
      case 'server.name':
        return c.serverName;
      case 'args':
        return c.args.join(' ');
      case 'uses':
        return String(c.uses);
      default:
        return c.args[Number(key)] ?? '';
    }
  });
}

export default defineCog({
  setup(cog: Cog) {
    cog.config.registerGuild({ commands: {} as Record<string, CustomCommand> });
    const lastUse = new Map<string, number>();
    const all = (guildId: string) => cog.config.guild(guildId).get<Record<string, CustomCommand>>('commands');

    cog.on('commandNotFound', async (event: CommandNotFoundEvent) => {
      // Erst andere Listener (z. B. alias) zum Zug kommen lassen.
      await Promise.resolve();
      if (event.handled) return;
      const guildId = event.message.guild_id;
      if (!guildId) return;
      const m = /^(\S+)\s*([\s\S]*)$/.exec(event.text);
      if (!m) return;
      const name = m[1]!.toLowerCase();
      const cc = all(guildId)[name];
      if (!cc) return;
      event.handled = true;
      const msg = event.message;
      const now = Date.now();
      for (const [bucket, seconds] of Object.entries(cc.cooldowns)) {
        if (!seconds) continue;
        const id = bucket === 'user' ? msg.author.id : bucket === 'channel' ? msg.channel_id : guildId;
        const key = `${guildId}:${name}:${bucket}:${id}`;
        if (now - (lastUse.get(key) ?? 0) < seconds * 1000) return;
        lastUse.set(key, now);
      }
      const response = cc.type === 'random' ? cc.responses[Math.floor(Math.random() * cc.responses.length)]! : cc.responses[0]!;
      const uses = cc.uses + 1;
      cog.config.guild(guildId).update<Record<string, CustomCommand>>('commands', (c) => (c[name] ? { ...c, [name]: { ...c[name]!, uses } } : c));
      const text = renderTemplate(response, {
        author: msg.author,
        channelId: msg.channel_id,
        channelName: cog.platform.getChannel(msg.channel_id)?.name ?? '',
        serverName: cog.platform.getGuild(guildId)?.name ?? '',
        args: tokenize(m[2] ?? '').map((t) => t.value),
        uses,
      });
      if (text.trim()) await cog.bot.send(msg.channel_id, { content: text, allowed_mentions: { parse: ['users'] } }, guildId);
    });

    const nameOpt = { name: 'name', description: 'Befehlsname (ohne Prefix)', type: OptionType.String, required: true } as const;
    const validName = (ctx: CommandContext, raw: string): string => {
      const name = raw.toLowerCase();
      if (!NAME_RE.test(name)) throw new UserError(ctx.t('badName'));
      if (ctx.bot.registry.get(name)) throw new UserError(ctx.t('isBuiltin', { name }));
      return name;
    };
    const getCc = (ctx: CommandContext, name: string): CustomCommand => {
      const cc = all(ctx.guildId!)[name.toLowerCase()];
      if (!cc) throw new UserError(ctx.t('notFound', { name }));
      return cc;
    };
    const save = (ctx: CommandContext, name: string, cc: CustomCommand) =>
      cog.config.guild(ctx.guildId!).update<Record<string, CustomCommand>>('commands', (c) => ({ ...c, [name]: cc }));

    const create = (type: 'simple' | 'random') => ({
      name: type,
      description: type === 'simple' ? 'Befehl mit fester Antwort.' : 'Befehl mit zufälliger Antwort (Antworten mit | trennen).',
      options: [nameOpt, { name: 'antwort', description: type === 'simple' ? 'Antworttext' : 'Antwort 1 | Antwort 2 | …', type: OptionType.String, required: true, rest: true, max_length: 2000 }],
      run: async (ctx: CommandContext) => {
        const name = validName(ctx, ctx.arg<string>('name'));
        if (all(ctx.guildId!)[name]) throw new UserError(ctx.t('exists', { name }));
        const text = ctx.arg<string>('antwort');
        const responses = type === 'random' ? text.split('|').map((r) => r.trim()).filter(Boolean) : [text];
        if (type === 'random' && responses.length < 2) throw new UserError(ctx.t('randomNeedsTwo'));
        save(ctx, name, { type, responses, cooldowns: {}, author: ctx.author.id, createdAt: Date.now(), uses: 0 });
        await ctx.reply(ctx.t('created', { name: `${ctx.prefix}${name}` }));
      },
    });

    cog.group({
      name: 'customcom',
      description: 'Eigene Befehle verwalten.',
      aliases: ['cc'],
      guildOnly: true,
      subcommands: [
        {
          name: 'create',
          description: 'Neuen eigenen Befehl anlegen.',
          aliases: ['add'],
          permissions: { level: 'mod', member: ['ManageMessages'] },
          subcommands: [create('simple'), create('random')],
        },
        {
          name: 'edit',
          description: 'Antwort ändern (bei zufälligen Befehlen mit | trennen).',
          permissions: { level: 'mod', member: ['ManageMessages'] },
          options: [nameOpt, { name: 'antwort', description: 'Neue Antwort', type: OptionType.String, required: true, rest: true, max_length: 2000 }],
          run: async (ctx) => {
            const name = ctx.arg<string>('name').toLowerCase();
            const cc = getCc(ctx, name);
            const text = ctx.arg<string>('antwort');
            const responses = cc.type === 'random' ? text.split('|').map((r) => r.trim()).filter(Boolean) : [text];
            save(ctx, name, { ...cc, responses });
            await ctx.tick();
          },
        },
        {
          name: 'delete',
          description: 'Eigenen Befehl löschen.',
          aliases: ['del', 'remove'],
          permissions: { level: 'mod', member: ['ManageMessages'] },
          options: [nameOpt],
          run: async (ctx) => {
            const name = ctx.arg<string>('name').toLowerCase();
            getCc(ctx, name);
            cog.config.guild(ctx.guildId!).update<Record<string, CustomCommand>>('commands', (c) => {
              const { [name]: _gone, ...rest } = c;
              return rest;
            });
            await ctx.reply(ctx.t('deleted', { name }));
          },
        },
        {
          name: 'cooldown',
          description: 'Cooldown setzen (0 = aus) pro user, channel oder server.',
          permissions: { level: 'mod', member: ['ManageMessages'] },
          options: [
            nameOpt,
            { name: 'sekunden', description: 'Sekunden', type: OptionType.Integer, required: true, min_value: 0, max_value: 86400 },
            {
              name: 'pro',
              description: 'user, channel oder server',
              type: OptionType.String,
              default: 'user',
              choices: [
                { name: 'user', value: 'user' },
                { name: 'channel', value: 'channel' },
                { name: 'server', value: 'server' },
              ],
            },
          ],
          run: async (ctx) => {
            const name = ctx.arg<string>('name').toLowerCase();
            const cc = getCc(ctx, name);
            save(ctx, name, { ...cc, cooldowns: { ...cc.cooldowns, [ctx.arg<string>('pro')]: ctx.arg<number>('sekunden') } });
            await ctx.tick();
          },
        },
        {
          name: 'list',
          description: 'Alle eigenen Befehle.',
          run: async (ctx) => {
            const entries = Object.entries(all(ctx.guildId!)).sort(([a], [b]) => a.localeCompare(b));
            if (!entries.length) return ctx.reply(ctx.t('none'));
            const lines = entries.map(([n, c]) => `\`${ctx.prefix}${n}\` – ${c.responses[0]!.replace(/\n/g, ' ').slice(0, 60)}${c.type === 'random' ? ` (+${c.responses.length - 1})` : ''}`);
            await ctx.paginate(pagify(lines.join('\n'), { pageLength: 1800 }).map((pg) => embed({ title: ctx.t('listTitle'), description: pg })));
          },
        },
        {
          name: 'show',
          description: 'Details zu einem eigenen Befehl.',
          aliases: ['raw'],
          options: [nameOpt],
          run: async (ctx) => {
            const name = ctx.arg<string>('name').toLowerCase();
            const cc = getCc(ctx, name);
            const cds = Object.entries(cc.cooldowns).filter(([, s]) => s).map(([b, s]) => `${s}s/${b}`).join(', ') || '–';
            await ctx.sendEmbed({
              title: `${ctx.prefix}${name}`,
              description: cc.responses.map((r, i) => `**${i + 1}.** \`\`\`\n${r.replace(/```/g, 'ˋˋˋ')}\n\`\`\``).join('\n').slice(0, 4000),
              fields: [
                { name: ctx.t('fields.type'), value: ctx.t(`types.${cc.type}`), inline: true },
                { name: ctx.t('fields.cooldown'), value: cds, inline: true },
                { name: ctx.t('fields.uses'), value: String(cc.uses), inline: true },
                { name: ctx.t('fields.author'), value: `<@${cc.author}> – ${formatDateTime(cc.createdAt)}` },
              ],
            });
          },
        },
        {
          name: 'search',
          description: 'Eigene Befehle durchsuchen.',
          options: [{ name: 'text', description: 'Suchtext', type: OptionType.String, required: true, rest: true }],
          run: async (ctx) => {
            const needle = ctx.arg<string>('text').toLowerCase();
            const hits = Object.entries(all(ctx.guildId!)).filter(([n, c]) => n.includes(needle) || c.responses.some((r) => r.toLowerCase().includes(needle)));
            await ctx.reply(hits.length ? hits.map(([n]) => `\`${ctx.prefix}${n}\``).join(', ') : ctx.t('noHits'));
          },
        },
      ],
    });
  },
});
