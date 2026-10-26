import {
  defineCog,
  formatDateTime,
  humanizeSeconds,
  OptionType,
  takeDuration,
  takeInteger,
  UserError,
  type Cog,
  type CommandContext,
  type ResolvedUser,
} from '@bot/sdk';
import type { ModlogApi } from '../modlog/index.js';

const MAX_TIMEOUT = 28 * 86400; // Annahme: wie Discord max. 28 Tage
const MAX_SLOWMODE = 6 * 3600;

interface TempBan {
  until: number;
  reason: string | null;
  moderatorId: string;
}

export default defineCog({
  setup(cog: Cog) {
    cog.config.registerGuild({
      dmOnAction: false,
      deleteDays: 0,
      respectHierarchy: true,
    });
    cog.config.registerCustom('tempban', { until: 0, reason: null, moderatorId: '' } as Record<string, unknown>);

    const modlog = () => cog.bot.cogApi<ModlogApi>('modlog');
    const p = () => cog.platform;

    /** Hierarchie prüfen (wenn aktiviert) und Fehler werfen. */
    const checkHierarchy = (ctx: CommandContext, targetId: string): void => {
      const problem = cog.bot.hierarchyProblem(ctx.guildId!, ctx.author.id, targetId);
      if (!problem) return;
      const respect = cog.config.guild(ctx.guildId!).get<boolean>('respectHierarchy');
      // Selbst/Bot/Serverbesitzer/Bot-Rolle gelten immer, die Moderator-Hierarchie nur wenn aktiviert.
      if (problem === 'hierarchy.actor' && !respect) return;
      throw new UserError(ctx.t(problem));
    };

    const notify = async (guildId: string, userId: string, actionKey: string, reason: string | null, extra = ''): Promise<void> => {
      if (!cog.config.guild(guildId).get<boolean>('dmOnAction')) return;
      const guildName = p().getGuild(guildId)?.name ?? guildId;
      const text = cog.tg(guildId, 'dm', { action: cog.tg(guildId, actionKey), server: guildName, reason: reason ?? cog.tg(guildId, 'common.noReason') }) + extra;
      await p().sendDM(userId, text).catch(() => undefined);
    };

    const name = (u: ResolvedUser) => u.user?.username ?? u.member?.user?.username ?? u.id;
    const reasonText = (ctx: CommandContext, reason: string | null) =>
      `${ctx.author.username}: ${reason ?? ctx.t('common.noReason')}`.slice(0, 500);

    // ------------------------------------------------------------------ kick
    cog.command({
      name: 'kick',
      description: 'Wirft ein Mitglied vom Server.',
      guildOnly: true,
      permissions: { level: 'mod', member: ['KickMembers'], bot: ['KickMembers'] },
      options: [
        { name: 'user', description: 'Mitglied', type: OptionType.User, required: true },
        { name: 'grund', description: 'Grund', type: OptionType.String, rest: true },
      ],
      run: async (ctx) => {
        const user = ctx.arg<ResolvedUser>('user');
        const reason = ctx.arg<string | undefined>('grund') ?? null;
        if (!user.member && !p().getMember(ctx.guildId!, user.id)) throw new UserError(ctx.t('notMember'));
        checkHierarchy(ctx, user.id);
        await notify(ctx.guildId!, user.id, 'actions.kick', reason);
        await p().kickMember(ctx.guildId!, user.id, reasonText(ctx, reason));
        await modlog()?.createCase({ guildId: ctx.guildId!, action: 'kick', targetId: user.id, moderatorId: ctx.author.id, reason });
        await ctx.reply(ctx.t('kicked', { user: name(user) }));
      },
    });

    // ------------------------------------------------------------------ ban
    const doBan = async (ctx: CommandContext, user: ResolvedUser, days: number, reason: string | null, action: 'ban' | 'hackban' | 'tempban', until?: Date) => {
      const isMember = Boolean(user.member ?? p().getMember(ctx.guildId!, user.id));
      if (isMember) checkHierarchy(ctx, user.id);
      else if (user.id === ctx.author.id) throw new UserError(ctx.t('hierarchy.self'));
      if (isMember) {
        const extra = until ? `\n${ctx.t('dmUntil', { until: formatDateTime(until) })}` : '';
        await notify(ctx.guildId!, user.id, `actions.${action}`, reason, extra);
      }
      await p().banMember(ctx.guildId!, user.id, { reason: reasonText(ctx, reason), deleteMessageSeconds: days * 86400 });
      const finalAction = action === 'ban' && !isMember ? 'hackban' : action;
      await modlog()?.createCase({ guildId: ctx.guildId!, action: finalAction, targetId: user.id, moderatorId: ctx.author.id, reason, until: until ?? null });
    };

    cog.command({
      name: 'ban',
      description: 'Bannt einen Benutzer (auch per ID, wenn er nicht auf dem Server ist).',
      guildOnly: true,
      permissions: { level: 'mod', member: ['BanMembers'], bot: ['BanMembers'] },
      options: [
        { name: 'user', description: 'Benutzer oder ID', type: OptionType.User, required: true },
        { name: 'rest', description: '[Tage Nachrichten löschen 0–7] [Grund]', type: OptionType.String, rest: true },
      ],
      examples: ['ban @Spammer 1 Werbung', 'ban 200000000000000004 Ban-Umgehung'],
      run: async (ctx) => {
        const user = ctx.arg<ResolvedUser>('user');
        const { value, rest } = takeInteger(ctx.arg<string | undefined>('rest') ?? '');
        const days = value ?? cog.config.guild(ctx.guildId!).get<number>('deleteDays');
        if (days < 0 || days > 7) throw new UserError(ctx.t('badDays'));
        await doBan(ctx, user, days, rest || null, 'ban');
        await ctx.reply(ctx.t('banned', { user: name(user) }));
      },
    });

    cog.command({
      name: 'tempban',
      description: 'Bannt einen Benutzer für eine bestimmte Zeit.',
      guildOnly: true,
      permissions: { level: 'mod', member: ['BanMembers'], bot: ['BanMembers'] },
      options: [
        { name: 'user', description: 'Benutzer', type: OptionType.User, required: true },
        { name: 'dauer', description: 'z. B. 1d, 12h, 1w', type: OptionType.String, required: true },
        { name: 'grund', description: 'Grund', type: OptionType.String, rest: true },
      ],
      examples: ['tempban @Troll 3d Beleidigungen'],
      run: async (ctx) => {
        const user = ctx.arg<ResolvedUser>('user');
        const { seconds } = takeDuration(ctx.arg<string>('dauer'), 'h');
        if (!seconds || seconds < 60) throw new UserError(ctx.t('badDuration'));
        const reason = ctx.arg<string | undefined>('grund') ?? null;
        const until = new Date(Date.now() + seconds * 1000);
        await doBan(ctx, user, cog.config.guild(ctx.guildId!).get<number>('deleteDays'), reason, 'tempban', until);
        cog.config.custom('tempban', ctx.guildId!, user.id).setAll({ until: until.getTime(), reason, moderatorId: ctx.author.id });
        await ctx.reply(ctx.t('tempbanned', { user: name(user), duration: humanizeSeconds(seconds) }));
      },
    });

    cog.command({
      name: 'softban',
      description: 'Bannt und entbannt sofort – entfernt das Mitglied und seine Nachrichten des letzten Tages.',
      guildOnly: true,
      permissions: { level: 'mod', member: ['BanMembers'], bot: ['BanMembers'] },
      options: [
        { name: 'user', description: 'Mitglied', type: OptionType.User, required: true },
        { name: 'grund', description: 'Grund', type: OptionType.String, rest: true },
      ],
      run: async (ctx) => {
        const user = ctx.arg<ResolvedUser>('user');
        const reason = ctx.arg<string | undefined>('grund') ?? null;
        if (!user.member && !p().getMember(ctx.guildId!, user.id)) throw new UserError(ctx.t('notMember'));
        checkHierarchy(ctx, user.id);
        await notify(ctx.guildId!, user.id, 'actions.softban', reason);
        await p().banMember(ctx.guildId!, user.id, { reason: reasonText(ctx, reason), deleteMessageSeconds: 86400 });
        await p().unbanMember(ctx.guildId!, user.id, reasonText(ctx, 'Softban'));
        await modlog()?.createCase({ guildId: ctx.guildId!, action: 'softban', targetId: user.id, moderatorId: ctx.author.id, reason });
        await ctx.reply(ctx.t('softbanned', { user: name(user) }));
      },
    });

    cog.command({
      name: 'unban',
      description: 'Hebt einen Bann auf.',
      guildOnly: true,
      permissions: { level: 'mod', member: ['BanMembers'], bot: ['BanMembers'] },
      options: [
        { name: 'user', description: 'Benutzer-ID', type: OptionType.User, required: true },
        { name: 'grund', description: 'Grund', type: OptionType.String, rest: true },
      ],
      run: async (ctx) => {
        const user = ctx.arg<ResolvedUser>('user');
        const reason = ctx.arg<string | undefined>('grund') ?? null;
        try {
          await p().unbanMember(ctx.guildId!, user.id, reasonText(ctx, reason));
        } catch (err) {
          if ((err as { statusCode?: number }).statusCode === 404) throw new UserError(ctx.t('notBanned'));
          throw err;
        }
        cog.config.custom('tempban', ctx.guildId!, user.id).clear();
        await modlog()?.createCase({ guildId: ctx.guildId!, action: 'unban', targetId: user.id, moderatorId: ctx.author.id, reason });
        await ctx.reply(ctx.t('unbanned', { user: name(user) }));
      },
    });

    // ------------------------------------------------------------------ timeout
    cog.command({
      name: 'timeout',
      description: 'Setzt ein Mitglied in den Timeout (max. 28 Tage).',
      aliases: ['to'],
      guildOnly: true,
      permissions: { level: 'mod', member: ['ModerateMembers'], bot: ['ModerateMembers'] },
      options: [
        { name: 'user', description: 'Mitglied', type: OptionType.User, required: true },
        { name: 'dauer', description: 'z. B. 10m, 1h, 1d', type: OptionType.String, required: true },
        { name: 'grund', description: 'Grund', type: OptionType.String, rest: true },
      ],
      examples: ['timeout @Laut 15m Spam'],
      run: async (ctx) => {
        const user = ctx.arg<ResolvedUser>('user');
        const { seconds } = takeDuration(ctx.arg<string>('dauer'), 'm');
        if (!seconds || seconds < 10 || seconds > MAX_TIMEOUT) throw new UserError(ctx.t('badTimeout'));
        const reason = ctx.arg<string | undefined>('grund') ?? null;
        checkHierarchy(ctx, user.id);
        const until = new Date(Date.now() + seconds * 1000);
        await notify(ctx.guildId!, user.id, 'actions.timeout', reason, `\n${ctx.t('dmUntil', { until: formatDateTime(until) })}`);
        await p().timeoutMember(ctx.guildId!, user.id, until, reasonText(ctx, reason));
        await modlog()?.createCase({ guildId: ctx.guildId!, action: 'timeout', targetId: user.id, moderatorId: ctx.author.id, reason, until });
        await ctx.reply(ctx.t('timedOut', { user: name(user), duration: humanizeSeconds(seconds) }));
      },
    });

    cog.command({
      name: 'untimeout',
      description: 'Hebt einen Timeout auf.',
      guildOnly: true,
      permissions: { level: 'mod', member: ['ModerateMembers'], bot: ['ModerateMembers'] },
      options: [
        { name: 'user', description: 'Mitglied', type: OptionType.User, required: true },
        { name: 'grund', description: 'Grund', type: OptionType.String, rest: true },
      ],
      run: async (ctx) => {
        const user = ctx.arg<ResolvedUser>('user');
        const reason = ctx.arg<string | undefined>('grund') ?? null;
        await p().timeoutMember(ctx.guildId!, user.id, null, reasonText(ctx, reason));
        await modlog()?.createCase({ guildId: ctx.guildId!, action: 'untimeout', targetId: user.id, moderatorId: ctx.author.id, reason });
        await ctx.reply(ctx.t('untimedOut', { user: name(user) }));
      },
    });

    // ------------------------------------------------------------------ weitere
    cog.command({
      name: 'rename',
      description: 'Ändert den Nickname eines Mitglieds (ohne Name: zurücksetzen).',
      guildOnly: true,
      permissions: { level: 'mod', member: ['ManageNicknames'], bot: ['ManageNicknames'] },
      options: [
        { name: 'user', description: 'Mitglied', type: OptionType.User, required: true },
        { name: 'nickname', description: 'Neuer Nickname', type: OptionType.String, rest: true, max_length: 32 },
      ],
      run: async (ctx) => {
        const user = ctx.arg<ResolvedUser>('user');
        const nick = ctx.arg<string | undefined>('nickname') ?? null;
        if (user.id !== ctx.author.id) checkHierarchy(ctx, user.id);
        await p().editMember(ctx.guildId!, user.id, { nick }, reasonText(ctx, 'rename'));
        await ctx.reply(nick ? ctx.t('renamed', { user: name(user), nick }) : ctx.t('nickReset', { user: name(user) }));
      },
    });

    cog.command({
      name: 'slowmode',
      description: 'Setzt den Slowmode dieses Kanals (0 = aus).',
      guildOnly: true,
      permissions: { level: 'mod', member: ['ManageChannels'], bot: ['ManageChannels'] },
      options: [{ name: 'intervall', description: 'z. B. 10s, 1m, 0', type: OptionType.String, default: '0' }],
      run: async (ctx) => {
        const raw = ctx.arg<string>('intervall');
        const seconds = raw === '0' ? 0 : takeDuration(raw, 's').seconds;
        if (seconds === undefined || seconds > MAX_SLOWMODE) throw new UserError(ctx.t('badSlowmode'));
        await p().editChannel(ctx.channelId, { rate_limit_per_user: seconds }, reasonText(ctx, 'slowmode'));
        await ctx.reply(seconds ? ctx.t('slowmodeOn', { time: humanizeSeconds(seconds) }) : ctx.t('slowmodeOff'));
      },
    });

    cog.command({
      name: 'voicekick',
      description: 'Trennt ein Mitglied vom Sprachkanal.',
      guildOnly: true,
      permissions: { level: 'mod', member: ['MoveMembers'], bot: ['MoveMembers'] },
      options: [
        { name: 'user', description: 'Mitglied', type: OptionType.User, required: true },
        { name: 'grund', description: 'Grund', type: OptionType.String, rest: true },
      ],
      run: async (ctx) => {
        const user = ctx.arg<ResolvedUser>('user');
        const reason = ctx.arg<string | undefined>('grund') ?? null;
        if (!p().getVoiceState(ctx.guildId!, user.id)) throw new UserError(ctx.t('notInVoice'));
        checkHierarchy(ctx, user.id);
        await p().moveMember(ctx.guildId!, user.id, null, reasonText(ctx, reason));
        await modlog()?.createCase({ guildId: ctx.guildId!, action: 'voicekick', targetId: user.id, moderatorId: ctx.author.id, reason });
        await ctx.reply(ctx.t('voicekicked', { user: name(user) }));
      },
    });

    cog.command({
      name: 'userinfo',
      description: 'Informationen über ein Mitglied.',
      aliases: ['ui'],
      guildOnly: true,
      options: [{ name: 'user', description: 'Mitglied (Standard: du)', type: OptionType.User }],
      run: async (ctx) => {
        const target = ctx.arg<ResolvedUser | undefined>('user') ?? { id: ctx.author.id, user: ctx.author, member: ctx.member };
        const member = target.member ?? (await p().fetchMember(ctx.guildId!, target.id).catch(() => undefined));
        const user = target.user ?? member?.user;
        const g = ctx.guild;
        const roles = (member?.roles ?? [])
          .map((r) => g?.roles.get(r))
          .filter((r): r is NonNullable<typeof r> => Boolean(r))
          .sort((a, b) => b.position - a.position)
          .map((r) => `<@&${r.id}>`);
        const voice = p().getVoiceState(ctx.guildId!, target.id);
        const cases = modlog()?.casesFor(ctx.guildId!, target.id).length;
        const fields = [
          { name: 'ID', value: `\`${target.id}\``, inline: true },
          { name: ctx.t('nick'), value: member?.nick ?? '–', inline: true },
          { name: ctx.t('joined'), value: member?.joined_at ? formatDateTime(new Date(member.joined_at)) : '–', inline: true },
          { name: ctx.t('roles', { count: roles.length }), value: roles.join(' ').slice(0, 1024) || '–' },
        ];
        if (voice?.channel_id) fields.push({ name: ctx.t('voice'), value: `<#${voice.channel_id}>`, inline: true });
        if (member?.communication_disabled_until && new Date(member.communication_disabled_until) > new Date()) {
          fields.push({ name: ctx.t('timeoutUntil'), value: formatDateTime(new Date(member.communication_disabled_until)), inline: true });
        }
        if (cases !== undefined && (await ctx.bot.isImmune(ctx.guildId!, ctx.author.id))) fields.push({ name: ctx.t('cases'), value: String(cases), inline: true });
        await ctx.sendEmbed({ title: user?.username ?? target.id, fields, color: 0x3498db });
      },
    });

    cog.group({
      name: 'modset',
      description: 'Einstellungen des Mod-Cogs.',
      guildOnly: true,
      permissions: { level: 'admin', member: ['ManageGuild'] },
      subcommands: [
        {
          name: 'show',
          description: 'Zeigt die Einstellungen.',
          run: async (ctx) => {
            const c = cog.config.guild(ctx.guildId!).all();
            await ctx.sendEmbed({
              title: ctx.t('settingsTitle'),
              fields: [
                { name: ctx.t('settings.dm'), value: c.dmOnAction ? '✅' : '❌', inline: true },
                { name: ctx.t('settings.deleteDays'), value: String(c.deleteDays), inline: true },
                { name: ctx.t('settings.hierarchy'), value: c.respectHierarchy ? '✅' : '❌', inline: true },
              ],
            });
          },
        },
        {
          name: 'dm',
          description: 'Betroffene vor Kick/Ban/Timeout per DM informieren.',
          options: [{ name: 'aktiv', description: 'an/aus', type: OptionType.Boolean, required: true }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('dmOnAction', ctx.arg<boolean>('aktiv'));
            await ctx.tick();
          },
        },
        {
          name: 'deletedays',
          description: 'Standard: Nachrichten der letzten X Tage beim Bann löschen (0–7).',
          options: [{ name: 'tage', description: '0–7', type: OptionType.Integer, required: true, min_value: 0, max_value: 7 }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('deleteDays', ctx.arg<number>('tage'));
            await ctx.tick();
          },
        },
        {
          name: 'hierarchy',
          description: 'Mods dürfen nur Mitglieder mit niedrigerer Rolle moderieren.',
          options: [{ name: 'aktiv', description: 'an/aus', type: OptionType.Boolean, required: true }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('respectHierarchy', ctx.arg<boolean>('aktiv'));
            await ctx.tick();
          },
        },
      ],
    });

    // ------------------------------------------------------------------ Tempbans auslaufen lassen
    cog.schedule({
      name: 'tempban-ablauf',
      every: 60,
      run: async () => {
        const all = cog.config.allCustom<TempBan & Record<string, unknown>>('tempban');
        for (const [key, ban] of Object.entries(all)) {
          if (!ban.until || ban.until > Date.now()) continue;
          const [guildId, userId] = key.split(':') as [string, string];
          try {
            await p().unbanMember(guildId, userId, cog.tg(guildId, 'tempbanExpired'));
            await modlog()?.createCase({ guildId, action: 'unban', targetId: userId, moderatorId: cog.platform.user?.id ?? null, reason: cog.tg(guildId, 'tempbanExpired') });
          } catch (err) {
            cog.log.warn({ err, guildId, userId }, 'Tempban konnte nicht aufgehoben werden');
          }
          cog.config.custom('tempban', guildId, userId).clear();
        }
      },
    });
  },
});
