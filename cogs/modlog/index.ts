import {
  defineCog,
  embed,
  formatDateTime,
  OptionType,
  pagify,
  UserError,
  type APIEmbed,
  type Cog,
  type CommandContext,
  type ResolvedUser,
} from '@bot/sdk';

/** Ein Moderationsfall. */
export interface CaseRecord {
  guildId: string;
  number: number;
  action: string;
  targetId: string;
  targetName: string;
  moderatorId: string | null;
  reason: string | null;
  createdAt: number;
  until: number | null;
  channelId: string | null;
  messageId: string | null;
  amendedBy: string | null;
}

export interface CreateCaseInput {
  guildId: string;
  action: string;
  targetId: string;
  moderatorId?: string | null;
  reason?: string | null;
  until?: Date | number | null;
}

/** Schnittstelle für andere Cogs: `cog.bot.cogApi<ModlogApi>('modlog')`. */
export interface ModlogApi {
  createCase(input: CreateCaseInput): Promise<CaseRecord | null>;
  getCase(guildId: string, number: number): CaseRecord | undefined;
  casesFor(guildId: string, userId: string): CaseRecord[];
  actionTypes(): string[];
}

/** Aktionstypen mit Emoji. Standardmäßig deaktiviert (wie bei Red): filterhit. */
export const ACTIONS: Record<string, { emoji: string; defaultEnabled: boolean }> = {
  ban: { emoji: '🔨', defaultEnabled: true },
  hackban: { emoji: '🔨', defaultEnabled: true },
  tempban: { emoji: '⏳', defaultEnabled: true },
  softban: { emoji: '🔄', defaultEnabled: true },
  unban: { emoji: '🕊️', defaultEnabled: true },
  kick: { emoji: '👢', defaultEnabled: true },
  timeout: { emoji: '⏱️', defaultEnabled: true },
  untimeout: { emoji: '⏱️', defaultEnabled: true },
  mute: { emoji: '🔇', defaultEnabled: true },
  unmute: { emoji: '🔊', defaultEnabled: true },
  channelmute: { emoji: '🔇', defaultEnabled: true },
  channelunmute: { emoji: '🔊', defaultEnabled: true },
  voicekick: { emoji: '🔈', defaultEnabled: true },
  warning: { emoji: '⚠️', defaultEnabled: true },
  unwarn: { emoji: '✔️', defaultEnabled: true },
  automod: { emoji: '🤖', defaultEnabled: true },
  filterhit: { emoji: '🗑️', defaultEnabled: false },
  inviteblock: { emoji: '📨', defaultEnabled: false },
  rename: { emoji: '✏️', defaultEnabled: false },
};

interface Row {
  guild_id: string;
  case_number: number;
  action: string;
  target_id: string;
  target_name: string;
  moderator_id: string | null;
  reason: string | null;
  created_at: number;
  until: number | null;
  channel_id: string | null;
  message_id: string | null;
  amended_by: string | null;
}

function toRecord(r: Row): CaseRecord {
  return {
    guildId: r.guild_id,
    number: r.case_number,
    action: r.action,
    targetId: r.target_id,
    targetName: r.target_name,
    moderatorId: r.moderator_id,
    reason: r.reason,
    createdAt: r.created_at,
    until: r.until,
    channelId: r.channel_id,
    messageId: r.message_id,
    amendedBy: r.amended_by,
  };
}

export default defineCog({
  setup(cog: Cog) {
    const T = cog.tablePrefix + 'cases';
    cog.migrate([
      `CREATE TABLE IF NOT EXISTS ${T} (
        guild_id TEXT NOT NULL, case_number INTEGER NOT NULL, action TEXT NOT NULL,
        target_id TEXT NOT NULL, target_name TEXT NOT NULL, moderator_id TEXT, reason TEXT,
        created_at INTEGER NOT NULL, until INTEGER, channel_id TEXT, message_id TEXT, amended_by TEXT,
        PRIMARY KEY (guild_id, case_number))`,
      `CREATE INDEX IF NOT EXISTS ${T}_target ON ${T} (guild_id, target_id)`,
    ]);
    cog.config.registerGuild({ channel: null as string | null, disabled: [] as string[], enabled: [] as string[] });

    const db = cog.db;
    const q = {
      next: db.prepare(`SELECT COALESCE(MAX(case_number), 0) + 1 AS n FROM ${T} WHERE guild_id = ?`),
      insert: db.prepare(
        `INSERT INTO ${T} (guild_id, case_number, action, target_id, target_name, moderator_id, reason, created_at, until)
         VALUES (@guild_id, @case_number, @action, @target_id, @target_name, @moderator_id, @reason, @created_at, @until)`,
      ),
      get: db.prepare(`SELECT * FROM ${T} WHERE guild_id = ? AND case_number = ?`),
      forUser: db.prepare(`SELECT * FROM ${T} WHERE guild_id = ? AND target_id = ? ORDER BY case_number`),
      lastBy: db.prepare(`SELECT * FROM ${T} WHERE guild_id = ? AND moderator_id = ? ORDER BY case_number DESC LIMIT 1`),
      setMessage: db.prepare(`UPDATE ${T} SET channel_id = ?, message_id = ? WHERE guild_id = ? AND case_number = ?`),
      setReason: db.prepare(`UPDATE ${T} SET reason = ?, amended_by = ? WHERE guild_id = ? AND case_number = ?`),
      reset: db.prepare(`DELETE FROM ${T} WHERE guild_id = ?`),
    };

    const isEnabled = (guildId: string, action: string): boolean => {
      const conf = cog.config.guild(guildId);
      if (conf.get<string[]>('disabled').includes(action)) return false;
      if (conf.get<string[]>('enabled').includes(action)) return true;
      return ACTIONS[action]?.defaultEnabled ?? true;
    };

    const caseEmbed = (c: CaseRecord, guildId?: string): APIEmbed => {
      const info = ACTIONS[c.action];
      const fields = [
        { name: cog.tg(guildId, 'common.user'), value: `${c.targetName} (<@${c.targetId}>, \`${c.targetId}\`)`, inline: false },
        { name: cog.tg(guildId, 'common.moderator'), value: c.moderatorId ? `<@${c.moderatorId}>` : cog.tg(guildId, 'unknownModerator'), inline: true },
        { name: cog.tg(guildId, 'common.reason'), value: c.reason ?? cog.tg(guildId, 'noReason', { number: c.number }), inline: false },
      ];
      if (c.until) fields.push({ name: cog.tg(guildId, 'common.until'), value: formatDateTime(c.until), inline: true });
      if (c.amendedBy) fields.push({ name: cog.tg(guildId, 'amendedBy'), value: `<@${c.amendedBy}>`, inline: true });
      return embed({
        title: cog.tg(guildId, 'caseTitle', { number: c.number, action: cog.tg(guildId, `actions.${c.action}`), emoji: info?.emoji ?? '📝' }),
        fields,
        timestamp: new Date(c.createdAt),
        color: 0xe67e22,
      });
    };

    const post = async (c: CaseRecord): Promise<void> => {
      const channelId = cog.config.guild(c.guildId).get<string | null>('channel');
      if (!channelId) return;
      try {
        const payload = await cog.bot.adaptPayload({ embeds: [caseEmbed(c, c.guildId)] }, c.guildId, channelId);
        const msg = await cog.bot.send(channelId, payload, c.guildId);
        q.setMessage.run(channelId, msg.id, c.guildId, c.number);
      } catch (err) {
        cog.log.warn({ err, guild: c.guildId }, 'Fall konnte nicht im ModLog-Kanal gepostet werden');
      }
    };

    const api: ModlogApi = {
      async createCase(input) {
        if (!isEnabled(input.guildId, input.action)) return null;
        const user = cog.platform.users.get(input.targetId) ?? cog.platform.getMember(input.guildId, input.targetId)?.user;
        const record = cog.db.transaction(() => {
          const n = (q.next.get(input.guildId) as { n: number }).n;
          const row = {
            guild_id: input.guildId,
            case_number: n,
            action: input.action,
            target_id: input.targetId,
            target_name: user?.username ?? input.targetId,
            moderator_id: input.moderatorId ?? null,
            reason: input.reason?.trim() || null,
            created_at: Date.now(),
            until: input.until ? new Date(input.until).getTime() : null,
          };
          q.insert.run(row);
          return toRecord({ ...row, channel_id: null, message_id: null, amended_by: null });
        })();
        await post(record);
        return record;
      },
      getCase(guildId, number) {
        const row = q.get.get(guildId, number) as Row | undefined;
        return row ? toRecord(row) : undefined;
      },
      casesFor(guildId, userId) {
        return (q.forUser.all(guildId, userId) as Row[]).map(toRecord);
      },
      actionTypes: () => Object.keys(ACTIONS),
    };
    cog.expose(api);

    const requireCase = (ctx: CommandContext, n: number): CaseRecord => {
      const c = api.getCase(ctx.guildId!, n);
      if (!c) throw new UserError(ctx.t('caseNotFound', { number: n }));
      return c;
    };

    const modPerms = { level: 'mod', member: ['BanMembers'] } as const;

    cog.command({
      name: 'case',
      description: 'Zeigt einen Moderationsfall.',
      guildOnly: true,
      permissions: modPerms,
      options: [{ name: 'nummer', description: 'Fallnummer', type: OptionType.Integer, required: true, min_value: 1 }],
      run: async (ctx) => {
        await ctx.sendEmbed(caseEmbed(requireCase(ctx, ctx.arg<number>('nummer')), ctx.guildId));
      },
    });

    cog.command({
      name: 'casesfor',
      description: 'Alle Fälle eines Benutzers (ausführlich).',
      guildOnly: true,
      permissions: modPerms,
      options: [{ name: 'user', description: 'Benutzer (auch ID)', type: OptionType.User, required: true }],
      run: async (ctx) => {
        const user = ctx.arg<ResolvedUser>('user');
        const cases = api.casesFor(ctx.guildId!, user.id);
        if (!cases.length) return ctx.reply(ctx.t('noCases'));
        await ctx.paginate(cases.map((c) => caseEmbed(c, ctx.guildId)));
      },
    });

    cog.command({
      name: 'listcases',
      description: 'Alle Fälle eines Benutzers (kompakt).',
      guildOnly: true,
      permissions: modPerms,
      options: [{ name: 'user', description: 'Benutzer (auch ID)', type: OptionType.User, required: true }],
      run: async (ctx) => {
        const user = ctx.arg<ResolvedUser>('user');
        const cases = api.casesFor(ctx.guildId!, user.id);
        if (!cases.length) return ctx.reply(ctx.t('noCases'));
        const lines = cases.map(
          (c) => `**#${c.number}** ${ACTIONS[c.action]?.emoji ?? ''} ${ctx.t(`actions.${c.action}`)} – ${formatDateTime(c.createdAt)} – ${c.reason ?? '–'}`,
        );
        await ctx.paginate(pagify(lines.join('\n'), { pageLength: 1800 }).map((p) => embed({ title: ctx.t('listTitle', { user: cases[0]!.targetName }), description: p })));
      },
    });

    cog.command({
      name: 'reason',
      description: 'Setzt oder ändert den Grund eines Falls (ohne Nummer: dein letzter Fall).',
      guildOnly: true,
      permissions: modPerms,
      options: [{ name: 'text', description: '[Fallnummer] Grund', type: OptionType.String, required: true, rest: true }],
      examples: ['reason 12 Spam in #allgemein', 'reason Beleidigung'],
      run: async (ctx) => {
        const text = ctx.arg<string>('text');
        const m = /^(\d+)\s+([\s\S]+)$/.exec(text);
        let c: CaseRecord | undefined;
        let reason = text;
        if (m) {
          c = requireCase(ctx, Number(m[1]));
          reason = m[2]!;
        } else {
          const row = q.lastBy.get(ctx.guildId!, ctx.author.id) as Row | undefined;
          if (!row) throw new UserError(ctx.t('noOwnCase'));
          c = toRecord(row);
        }
        const level = await ctx.bot.levelOf(ctx.guildId, ctx.author.id);
        if (c.moderatorId && c.moderatorId !== ctx.author.id && !['admin', 'guildowner', 'owner'].includes(level)) {
          throw new UserError(ctx.t('notYourCase'));
        }
        q.setReason.run(reason, c.moderatorId === ctx.author.id ? null : ctx.author.id, ctx.guildId, c.number);
        const updated = api.getCase(ctx.guildId!, c.number)!;
        if (updated.channelId && updated.messageId) {
          const payload = await ctx.bot.adaptPayload({ embeds: [caseEmbed(updated, ctx.guildId)] }, ctx.guildId, updated.channelId);
          await ctx.bot.platform.editMessage(updated.channelId, updated.messageId, payload).catch(() => undefined);
        }
        await ctx.reply(ctx.t('reasonSet', { number: c.number }));
      },
    });

    cog.group({
      name: 'modlogset',
      description: 'ModLog-Einstellungen.',
      guildOnly: true,
      permissions: { level: 'admin', member: ['ManageGuild'] },
      subcommands: [
        {
          name: 'channel',
          description: 'Setzt den ModLog-Kanal (ohne Angabe: deaktivieren).',
          options: [{ name: 'kanal', description: 'Textkanal', type: OptionType.Channel, channel_types: [0, 5] }],
          run: async (ctx) => {
            const channel = ctx.arg<{ id: string } | undefined>('kanal');
            cog.config.guild(ctx.guildId!).set('channel', channel?.id ?? null);
            await ctx.reply(channel ? ctx.t('channelSet', { channel: `<#${channel.id}>` }) : ctx.t('channelCleared'));
          },
        },
        {
          name: 'cases',
          description: 'Zeigt, welche Aktionen geloggt werden.',
          run: async (ctx) => {
            const lines = Object.entries(ACTIONS).map(
              ([a, info]) => `${isEnabled(ctx.guildId!, a) ? '✅' : '❌'} ${info.emoji} \`${a}\` – ${ctx.t(`actions.${a}`)}`,
            );
            await ctx.sendEmbed({ title: ctx.t('casesTitle'), description: lines.join('\n'), footer: ctx.t('casesFooter', { prefix: ctx.prefix }) });
          },
        },
        {
          name: 'toggle',
          description: 'Schaltet das Loggen einer Aktion um.',
          options: [{ name: 'aktion', description: 'z. B. ban, kick, filterhit', type: OptionType.String, required: true }],
          run: async (ctx) => {
            const action = ctx.arg<string>('aktion').toLowerCase();
            if (!ACTIONS[action]) throw new UserError(ctx.t('unknownAction', { actions: Object.keys(ACTIONS).join(', ') }));
            const conf = cog.config.guild(ctx.guildId!);
            const now = !isEnabled(ctx.guildId!, action);
            conf.set('disabled', conf.get<string[]>('disabled').filter((a) => a !== action).concat(now ? [] : [action]));
            conf.set('enabled', conf.get<string[]>('enabled').filter((a) => a !== action).concat(now ? [action] : []));
            await ctx.reply(ctx.t(now ? 'toggledOn' : 'toggledOff', { action }));
          },
        },
        {
          name: 'resetcases',
          description: 'Löscht alle Fälle dieses Servers.',
          permissions: { level: 'guildowner', member: ['Administrator'] },
          run: async (ctx) => {
            if (!(await ctx.confirm(ctx.t('resetConfirm')))) return ctx.reply(ctx.t('common.cancelled'));
            q.reset.run(ctx.guildId);
            await ctx.reply(ctx.t('resetDone'));
          },
        },
      ],
    });
  },
});
