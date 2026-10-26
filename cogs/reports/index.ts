import {
  defineCog,
  embed,
  formatDateTime,
  NUMBER_EMOJIS,
  OptionType,
  pagify,
  resolveUser,
  sameEmoji,
  UserError,
  type APIEmbed,
  type Cog,
  type CommandContext,
  type ReactionEvent,
} from '@bot/sdk';

interface ReportRow {
  guild_id: string;
  number: number;
  reporter_id: string;
  target_id: string | null;
  text: string;
  channel_id: string | null;
  message_id: string | null;
  status: 'open' | 'done';
  handled_by: string | null;
  created_at: number;
}

const DONE = '✅';

export default defineCog({
  setup(cog: Cog) {
    const T = cog.tablePrefix + 'reports';
    cog.migrate([
      `CREATE TABLE IF NOT EXISTS ${T} (
        guild_id TEXT NOT NULL, number INTEGER NOT NULL, reporter_id TEXT NOT NULL, target_id TEXT, text TEXT NOT NULL,
        channel_id TEXT, message_id TEXT, status TEXT NOT NULL DEFAULT 'open', handled_by TEXT, created_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, number))`,
      `CREATE INDEX IF NOT EXISTS ${T}_msg ON ${T} (message_id)`,
    ]);
    cog.config.registerGuild({ output: null as string | null, enabled: true, notifyReporter: true });
    const db = cog.db;
    const q = {
      next: db.prepare(`SELECT COALESCE(MAX(number), 0) + 1 AS n FROM ${T} WHERE guild_id = ?`),
      insert: db.prepare(`INSERT INTO ${T} (guild_id, number, reporter_id, target_id, text, created_at) VALUES (?, ?, ?, ?, ?, ?)`),
      setMsg: db.prepare(`UPDATE ${T} SET channel_id = ?, message_id = ? WHERE guild_id = ? AND number = ?`),
      byMsg: db.prepare(`SELECT * FROM ${T} WHERE message_id = ?`),
      done: db.prepare(`UPDATE ${T} SET status = 'done', handled_by = ? WHERE guild_id = ? AND number = ?`),
      open: db.prepare(`SELECT * FROM ${T} WHERE guild_id = ? AND status = 'open' ORDER BY number`),
    };
    const p = () => cog.platform;

    const reportEmbed = (r: ReportRow): APIEmbed =>
      embed({
        title: cog.tg(r.guild_id, 'embedTitle', { number: r.number }),
        description: r.text,
        fields: [
          { name: cog.tg(r.guild_id, 'reporter'), value: `<@${r.reporter_id}> (\`${r.reporter_id}\`)`, inline: true },
          { name: cog.tg(r.guild_id, 'target'), value: r.target_id ? `<@${r.target_id}> (\`${r.target_id}\`)` : '–', inline: true },
          ...(r.status === 'done' ? [{ name: cog.tg(r.guild_id, 'handledBy'), value: r.handled_by ? `<@${r.handled_by}>` : '–', inline: true }] : []),
        ],
        footer: r.status === 'done' ? cog.tg(r.guild_id, 'statusDone') : cog.tg(r.guild_id, 'statusOpen'),
        timestamp: new Date(r.created_at),
        color: r.status === 'done' ? 0x2ecc71 : 0xe67e22,
      });

    async function file(guildId: string, reporterId: string, targetId: string | null, text: string): Promise<number> {
      const conf = cog.config.guild(guildId);
      const output = conf.get<string | null>('output');
      if (!conf.get<boolean>('enabled') || !output) throw new UserError(cog.tg(guildId, 'notConfigured'));
      const number = db.transaction(() => {
        const n = (q.next.get(guildId) as { n: number }).n;
        q.insert.run(guildId, n, reporterId, targetId, text.slice(0, 3500), Date.now());
        return n;
      })();
      const row = { guild_id: guildId, number, reporter_id: reporterId, target_id: targetId, text, channel_id: null, message_id: null, status: 'open', handled_by: null, created_at: Date.now() } as ReportRow;
      const msg = await cog.bot.send(output, await cog.bot.adaptPayload({ embeds: [reportEmbed(row)] }, guildId, output), guildId);
      q.setMsg.run(output, msg.id, guildId, number);
      await p().addReaction(output, msg.id, DONE).catch(() => undefined);
      return number;
    }

    /** Text "[@user] Meldung" zerlegen. */
    const splitTarget = (ctx: CommandContext, guildId: string, text: string): { targetId: string | null; rest: string } => {
      const m = /^(\S+)\s+([\s\S]+)$/.exec(text.trim());
      if (m && (/^<@!?\d+>$/.test(m[1]!) || /^\d{15,21}$/.test(m[1]!))) {
        const user = resolveUser(m[1]!, { guild: p().getGuild(guildId), users: p().users, attachments: [] });
        if (user) return { targetId: user.id, rest: m[2]! };
      }
      return { targetId: null, rest: text.trim() };
    };

    cog.command({
      name: 'report',
      description: 'Meldet etwas an das Team (im Server oder per DM an mich).',
      aliases: ['melden'],
      cooldown: { rate: 2, per: 60, bucket: 'user' },
      options: [{ name: 'meldung', description: '[@Benutzer] Was ist passiert?', type: OptionType.String, required: true, rest: true, max_length: 3000 }],
      examples: ['report @Troll beleidigt Leute in #allgemein', 'report Im Sprachkanal wird gespammt'],
      run: async (ctx) => {
        let guildId = ctx.guildId;
        if (!guildId) {
          // Per DM: gemeinsame Server mit aktivierten Meldungen
          const candidates = [...p().guilds.values()].filter(
            (g) => g.members.has(ctx.author.id) && cog.config.guild(g.id).get<string | null>('output') && cog.config.guild(g.id).get<boolean>('enabled'),
          );
          if (!candidates.length) throw new UserError(ctx.t('noServer'));
          if (candidates.length === 1) guildId = candidates[0]!.id;
          else {
            const list = candidates.slice(0, 10).map((g, i) => `${NUMBER_EMOJIS[i]} ${g.name}`).join('\n');
            const idx = await ctx.choose(embed({ title: ctx.t('chooseServer'), description: list }), Math.min(candidates.length, 10));
            if (idx === null) return ctx.reply(ctx.t('common.cancelled'));
            guildId = candidates[idx]!.id;
          }
        }
        const { targetId, rest } = splitTarget(ctx, guildId, ctx.arg<string>('meldung'));
        const number = await file(guildId, ctx.author.id, targetId, rest);
        if (ctx.guildId) await p().deleteMessage(ctx.channelId, ctx.message.id).catch(() => undefined);
        const confirmText = ctx.t('filed', { number, server: p().getGuild(guildId)?.name ?? '' });
        if (ctx.guildId) await ctx.dm(confirmText).catch(() => ctx.send(confirmText));
        else await ctx.reply(confirmText);
      },
    });

    // ✅ im Meldekanal → erledigt
    cog.on('MESSAGE_REACTION_ADD', async (e: ReactionEvent) => {
      if (!e.guild_id || e.user_id === p().user?.id || !sameEmoji(DONE, e.emoji)) return;
      const row = q.byMsg.get(e.message_id) as ReportRow | undefined;
      if (!row || row.status === 'done' || row.guild_id !== e.guild_id) return;
      if (!(await cog.bot.isImmune(e.guild_id, e.user_id))) return; // nur Mods+
      q.done.run(e.user_id, row.guild_id, row.number);
      const updated = { ...row, status: 'done' as const, handled_by: e.user_id };
      await p().editMessage(e.channel_id, e.message_id, await cog.bot.adaptPayload({ embeds: [reportEmbed(updated)] }, e.guild_id, e.channel_id)).catch(() => undefined);
      if (cog.config.guild(row.guild_id).get<boolean>('notifyReporter')) {
        await p().sendDM(row.reporter_id, cog.tg(row.guild_id, 'reporterNotified', { number: row.number, server: p().getGuild(row.guild_id)?.name ?? '' })).catch(() => undefined);
      }
    });

    cog.command({
      name: 'reports',
      description: 'Offene Meldungen anzeigen.',
      guildOnly: true,
      permissions: { level: 'mod', member: ['ManageMessages'] },
      run: async (ctx) => {
        const rows = q.open.all(ctx.guildId) as ReportRow[];
        if (!rows.length) return ctx.reply(ctx.t('noneOpen'));
        const lines = rows.map((r) => `**#${r.number}** – <@${r.reporter_id}>${r.target_id ? ` → <@${r.target_id}>` : ''} – ${formatDateTime(r.created_at)}\n${r.text.slice(0, 150)}`);
        await ctx.paginate(pagify(lines.join('\n\n'), { pageLength: 1800 }).map((pg) => embed({ title: ctx.t('openTitle', { count: rows.length }), description: pg })));
      },
    });

    cog.group({
      name: 'reportset',
      description: 'Einstellungen für Meldungen.',
      guildOnly: true,
      permissions: { level: 'admin', member: ['ManageGuild'] },
      subcommands: [
        {
          name: 'output',
          description: 'Kanal, in dem Meldungen ankommen.',
          options: [{ name: 'kanal', description: 'Team-Kanal', type: OptionType.Channel, required: true, channel_types: [0, 5] }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('output', ctx.arg<{ id: string }>('kanal').id);
            await ctx.reply(ctx.t('outputSet', { channel: `<#${ctx.arg<{ id: string }>('kanal').id}>` }));
          },
        },
        {
          name: 'toggle',
          description: 'Meldungen an/aus.',
          options: [{ name: 'aktiv', description: 'an/aus', type: OptionType.Boolean, required: true }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('enabled', ctx.arg<boolean>('aktiv'));
            await ctx.tick();
          },
        },
        {
          name: 'notify',
          description: 'Meldende per DM informieren, wenn erledigt.',
          options: [{ name: 'aktiv', description: 'an/aus', type: OptionType.Boolean, required: true }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('notifyReporter', ctx.arg<boolean>('aktiv'));
            await ctx.tick();
          },
        },
      ],
    });
  },
});
