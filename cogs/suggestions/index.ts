import { defineCog, embed, OptionType, takeInteger, UserError, type APIEmbed, type APIMessage, type Cog, type CommandContext } from '@bot/sdk';

interface Row {
  guild_id: string;
  number: number;
  author_id: string;
  text: string;
  status: 'open' | 'approved' | 'denied';
  channel_id: string | null;
  message_id: string | null;
  reason: string | null;
  decided_by: string | null;
  created_at: number;
}

const COLORS = { open: 0x3498db, approved: 0x2ecc71, denied: 0xe74c3c } as const;

export default defineCog({
  setup(cog: Cog) {
    const T = cog.tablePrefix + 'suggestions';
    cog.migrate([
      `CREATE TABLE IF NOT EXISTS ${T} (
        guild_id TEXT NOT NULL, number INTEGER NOT NULL, author_id TEXT NOT NULL, text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open', channel_id TEXT, message_id TEXT, reason TEXT, decided_by TEXT,
        created_at INTEGER NOT NULL, PRIMARY KEY (guild_id, number))`,
    ]);
    cog.config.registerGuild({
      enabled: true,
      channel: null as string | null,
      approvedChannel: null as string | null,
      deniedChannel: null as string | null,
      anonymous: false,
      dm: true,
      up: '👍',
      down: '👎',
    });
    const db = cog.db;
    const q = {
      next: db.prepare(`SELECT COALESCE(MAX(number), 0) + 1 AS n FROM ${T} WHERE guild_id = ?`),
      insert: db.prepare(`INSERT INTO ${T} (guild_id, number, author_id, text, created_at) VALUES (?, ?, ?, ?, ?)`),
      setMsg: db.prepare(`UPDATE ${T} SET channel_id = ?, message_id = ? WHERE guild_id = ? AND number = ?`),
      get: db.prepare(`SELECT * FROM ${T} WHERE guild_id = ? AND number = ?`),
      decide: db.prepare(`UPDATE ${T} SET status = ?, reason = ?, decided_by = ? WHERE guild_id = ? AND number = ?`),
    };
    const p = () => cog.platform;

    const render = (r: Row, votes?: { up: number; down: number }): APIEmbed => {
      const g = r.guild_id;
      const anonymous = cog.config.guild(g).get<boolean>('anonymous');
      const fields = [];
      if (r.status !== 'open') {
        fields.push({ name: cog.tg(g, `status.${r.status}`), value: `${r.reason ?? '–'}${r.decided_by ? `\n– <@${r.decided_by}>` : ''}` });
      }
      if (votes) fields.push({ name: cog.tg(g, 'votes'), value: `${cog.config.guild(g).get('up')} ${votes.up} · ${cog.config.guild(g).get('down')} ${votes.down}`, inline: true });
      return embed({
        title: cog.tg(g, 'title', { number: r.number }),
        description: r.text,
        author: anonymous ? cog.tg(g, 'anonymous') : (p().users.get(r.author_id)?.username ?? r.author_id),
        fields,
        color: COLORS[r.status],
        footer: anonymous ? undefined : `ID ${r.author_id}`,
        timestamp: new Date(r.created_at),
      });
    };

    const countVotes = async (r: Row): Promise<{ up: number; down: number } | undefined> => {
      if (!r.channel_id || !r.message_id) return undefined;
      const msg = (await p().fetchMessage(r.channel_id, r.message_id).catch(() => undefined)) as (APIMessage & { reactions?: Array<{ emoji: { name?: string | null }; count: number; me?: boolean }> }) | undefined;
      if (!msg) return undefined;
      const conf = cog.config.guild(r.guild_id);
      const count = (e: string) => {
        const re = msg.reactions?.find((x) => (x.emoji.name ?? '').replace(/️/g, '') === e.replace(/️/g, ''));
        return re ? Math.max(0, re.count - (re.me ? 1 : 0)) : 0;
      };
      return { up: count(conf.get<string>('up')), down: count(conf.get<string>('down')) };
    };

    cog.command({
      name: 'suggest',
      description: 'Reicht einen Vorschlag ein.',
      aliases: ['vorschlag'],
      guildOnly: true,
      cooldown: { rate: 1, per: 60, bucket: 'member' },
      options: [{ name: 'vorschlag', description: 'Dein Vorschlag', type: OptionType.String, required: true, rest: true, max_length: 2000 }],
      run: async (ctx) => {
        const conf = cog.config.guild(ctx.guildId!);
        const channel = conf.get<string | null>('channel');
        if (!conf.get<boolean>('enabled') || !channel) throw new UserError(ctx.t('notSetUp'));
        const number = db.transaction(() => {
          const n = (q.next.get(ctx.guildId) as { n: number }).n;
          q.insert.run(ctx.guildId, n, ctx.author.id, ctx.arg<string>('vorschlag'), Date.now());
          return n;
        })();
        const row = q.get.get(ctx.guildId, number) as Row;
        const msg = await ctx.bot.send(channel, await ctx.bot.adaptPayload({ embeds: [render(row)] }, ctx.guildId, channel), ctx.guildId);
        q.setMsg.run(channel, msg.id, ctx.guildId, number);
        for (const e of [conf.get<string>('up'), conf.get<string>('down')]) await p().addReaction(channel, msg.id, e).catch(() => undefined);
        if (channel !== ctx.channelId) await p().deleteMessage(ctx.channelId, ctx.message.id).catch(() => undefined);
        await ctx.send(ctx.t('submitted', { number, channel: `<#${channel}>` }));
      },
    });

    const decide = (status: 'approved' | 'denied') => ({
      name: status === 'approved' ? 'approve' : 'deny',
      description: status === 'approved' ? 'Vorschlag annehmen.' : 'Vorschlag ablehnen.',
      aliases: status === 'approved' ? ['annehmen'] : ['ablehnen'],
      options: [{ name: 'text', description: '<Nummer> [Begründung]', type: OptionType.String, required: true, rest: true }],
      run: async (ctx: CommandContext) => {
        const { value, rest } = takeInteger(ctx.arg<string>('text'));
        if (!value) throw new UserError(ctx.t('needNumber'));
        const row = q.get.get(ctx.guildId, value) as Row | undefined;
        if (!row) throw new UserError(ctx.t('notFound', { number: value }));
        q.decide.run(status, rest || null, ctx.author.id, ctx.guildId, value);
        const updated = q.get.get(ctx.guildId, value) as Row;
        const votes = await countVotes(updated);
        const e = render(updated, votes);
        if (updated.channel_id && updated.message_id) {
          await p().editMessage(updated.channel_id, updated.message_id, await ctx.bot.adaptPayload({ embeds: [e] }, ctx.guildId, updated.channel_id)).catch(() => undefined);
        }
        const conf = cog.config.guild(ctx.guildId!);
        const target = conf.get<string | null>(status === 'approved' ? 'approvedChannel' : 'deniedChannel');
        if (target) await ctx.bot.send(target, await ctx.bot.adaptPayload({ embeds: [e] }, ctx.guildId, target), ctx.guildId).catch(() => undefined);
        if (conf.get<boolean>('dm')) {
          await p()
            .sendDM(row.author_id, ctx.t(`dm.${status}`, { number: value, server: ctx.guild?.name ?? '', reason: rest || '–' }))
            .catch(() => undefined);
        }
        await ctx.reply(ctx.t(`decided.${status}`, { number: value }));
      },
    });

    cog.group({
      name: 'suggestion',
      description: 'Vorschläge bearbeiten.',
      guildOnly: true,
      permissions: { level: 'mod', member: ['ManageMessages'] },
      subcommands: [decide('approved'), decide('denied')],
    });

    const channelSetting = (name: string, key: string, description: string) => ({
      name,
      description,
      options: [{ name: 'kanal', description: 'Kanal (leer = keiner)', type: OptionType.Channel, channel_types: [0, 5] }],
      run: async (ctx: CommandContext) => {
        cog.config.guild(ctx.guildId!).set(key, ctx.arg<{ id: string } | undefined>('kanal')?.id ?? null);
        await ctx.tick();
      },
    });
    const boolSetting = (name: string, key: string, description: string) => ({
      name,
      description,
      options: [{ name: 'aktiv', description: 'an/aus', type: OptionType.Boolean, required: true }],
      run: async (ctx: CommandContext) => {
        cog.config.guild(ctx.guildId!).set(key, ctx.arg<boolean>('aktiv'));
        await ctx.tick();
      },
    });

    cog.group({
      name: 'suggestset',
      description: 'Vorschläge einrichten.',
      guildOnly: true,
      permissions: { level: 'admin', member: ['ManageGuild'] },
      subcommands: [
        channelSetting('channel', 'channel', 'Kanal, in dem Vorschläge erscheinen.'),
        channelSetting('approvedchannel', 'approvedChannel', 'Kanal für angenommene Vorschläge.'),
        channelSetting('deniedchannel', 'deniedChannel', 'Kanal für abgelehnte Vorschläge.'),
        boolSetting('toggle', 'enabled', 'Vorschläge an/aus.'),
        boolSetting('anonymous', 'anonymous', 'Einreichende Person nicht anzeigen.'),
        boolSetting('dm', 'dm', 'Einreichende per DM über die Entscheidung informieren.'),
        {
          name: 'emojis',
          description: 'Emojis für Zustimmung/Ablehnung.',
          options: [
            { name: 'dafuer', description: 'z. B. 👍', type: OptionType.String, required: true },
            { name: 'dagegen', description: 'z. B. 👎', type: OptionType.String, required: true },
          ],
          run: async (ctx: CommandContext) => {
            cog.config.guild(ctx.guildId!).setAll({ up: ctx.arg<string>('dafuer'), down: ctx.arg<string>('dagegen') });
            await ctx.tick();
          },
        },
      ],
    });
  },
});
