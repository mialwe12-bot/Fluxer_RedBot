import {
  defineCog,
  formatDateTime,
  humanizeSeconds,
  OptionType,
  PermissionFlags,
  takeDuration,
  UserError,
  type APIRole,
  type Cog,
  type CommandContext,
  type ResolvedUser,
} from '@bot/sdk';
import type { ModlogApi } from '../modlog/index.js';

const MAX_TIMEOUT = 28 * 86400;
/** Was eine Stummschaltung im Kanal verbietet (wie Red: schreiben, reagieren, sprechen). */
const MUTE_DENY = PermissionFlags.SendMessages | PermissionFlags.AddReactions | PermissionFlags.Speak;

interface ServerMute {
  type: 'role' | 'timeout';
  until: number;
  reason: string | null;
  roleId: string | null;
  moderatorId: string;
}
interface ChannelMute {
  until: number;
  reason: string | null;
  prevAllow: string | null;
  prevDeny: string | null;
  moderatorId: string;
}

/** Schnittstelle für andere Cogs (z. B. warnings). */
export interface MutesApi {
  mute(guildId: string, userId: string, seconds: number | null, reason: string | null, moderatorId: string): Promise<void>;
}

export default defineCog({
  setup(cog: Cog) {
    cog.config.registerGuild({ muteRole: null as string | null, defaultTime: null as number | null, dm: false });
    cog.config.registerCustom('mute', {});
    cog.config.registerCustom('cmute', {});
    const p = () => cog.platform;
    const modlog = () => cog.bot.cogApi<ModlogApi>('modlog');

    const notify = async (guildId: string, userId: string, key: string, vars: Record<string, string>) => {
      if (!cog.config.guild(guildId).get<boolean>('dm')) return;
      await p().sendDM(userId, cog.tg(guildId, key, { server: p().getGuild(guildId)?.name ?? guildId, ...vars })).catch(() => undefined);
    };

    /** Server-weit stummschalten. seconds = null → dauerhaft (Rolle) bzw. 28 Tage (Timeout). */
    async function serverMute(guildId: string, userId: string, seconds: number | null, reason: string | null, moderatorId: string): Promise<ServerMute> {
      const conf = cog.config.guild(guildId);
      const roleId = conf.get<string | null>('muteRole');
      const effective = seconds ?? conf.get<number | null>('defaultTime');
      const audit = `${reason ?? cog.tg(guildId, 'common.noReason')}`.slice(0, 400);
      let record: ServerMute;
      if (roleId && p().getGuild(guildId)?.roles.has(roleId)) {
        await p().addRole(guildId, userId, roleId, audit);
        record = { type: 'role', until: effective ? Date.now() + effective * 1000 : 0, reason, roleId, moderatorId };
      } else {
        const secs = Math.min(effective ?? MAX_TIMEOUT, MAX_TIMEOUT);
        await p().timeoutMember(guildId, userId, new Date(Date.now() + secs * 1000), audit);
        record = { type: 'timeout', until: Date.now() + secs * 1000, reason, roleId: null, moderatorId };
      }
      cog.config.custom('mute', guildId, userId).setAll(record as unknown as Record<string, unknown>);
      await modlog()?.createCase({ guildId, action: 'mute', targetId: userId, moderatorId, reason, until: record.until || null });
      await notify(guildId, userId, 'dmMuted', {
        reason: reason ?? cog.tg(guildId, 'common.noReason'),
        until: record.until ? formatDateTime(record.until) : cog.tg(guildId, 'common.forever'),
      });
      return record;
    }

    async function serverUnmute(guildId: string, userId: string, reason: string | null, moderatorId: string | null): Promise<boolean> {
      const rec = cog.config.custom('mute', guildId, userId).raw() as Partial<ServerMute>;
      const roleId = rec.roleId ?? cog.config.guild(guildId).get<string | null>('muteRole');
      const member = p().getMember(guildId, userId);
      let changed = false;
      if (roleId && (rec.type === 'role' || member?.roles.includes(roleId))) {
        await p().removeRole(guildId, userId, roleId, reason ?? undefined).catch(() => undefined);
        changed = true;
      }
      if (rec.type === 'timeout' || (member?.communication_disabled_until && new Date(member.communication_disabled_until) > new Date())) {
        await p().timeoutMember(guildId, userId, null, reason ?? undefined).catch(() => undefined);
        changed = true;
      }
      cog.config.custom('mute', guildId, userId).clear();
      if (changed || rec.type) {
        await modlog()?.createCase({ guildId, action: 'unmute', targetId: userId, moderatorId, reason });
        await notify(guildId, userId, 'dmUnmuted', {});
      }
      return changed || Boolean(rec.type);
    }

    async function channelUnmute(guildId: string, channelId: string, userId: string, reason: string | null, moderatorId: string | null): Promise<boolean> {
      const rec = cog.config.custom('cmute', guildId, channelId, userId).raw() as Partial<ChannelMute>;
      if (!rec.until && rec.until !== 0) return false;
      if (rec.prevAllow !== null && rec.prevAllow !== undefined) {
        await p().setChannelOverwrite(channelId, userId, { type: 1, allow: BigInt(rec.prevAllow), deny: BigInt(rec.prevDeny ?? '0') }, reason ?? undefined);
      } else {
        await p().deleteChannelOverwrite(channelId, userId, reason ?? undefined).catch(() => undefined);
      }
      cog.config.custom('cmute', guildId, channelId, userId).clear();
      await modlog()?.createCase({ guildId, action: 'channelunmute', targetId: userId, moderatorId, reason });
      return true;
    }

    cog.expose<MutesApi>({ mute: async (...args) => void (await serverMute(...args)) });

    const name = (u: ResolvedUser) => u.user?.username ?? u.id;
    const checkTarget = (ctx: CommandContext, userId: string) => {
      const problem = cog.bot.hierarchyProblem(ctx.guildId!, ctx.author.id, userId);
      if (problem) throw new UserError(ctx.t(problem));
    };
    const userAndRest = [
      { name: 'user', description: 'Mitglied', type: OptionType.User, required: true },
      { name: 'rest', description: '[Dauer] [Grund]', type: OptionType.String, rest: true },
    ];

    cog.command({
      name: 'mute',
      description: 'Schaltet ein Mitglied auf dem Server stumm (Mute-Rolle, sonst Timeout).',
      guildOnly: true,
      permissions: { level: 'mod', member: ['ModerateMembers'] },
      options: userAndRest,
      examples: ['mute @Laut 30m Spam', 'mute @Troll Beleidigungen'],
      run: async (ctx) => {
        const user = ctx.arg<ResolvedUser>('user');
        checkTarget(ctx, user.id);
        const { seconds, rest } = takeDuration(ctx.arg<string | undefined>('rest') ?? '');
        const rec = await serverMute(ctx.guildId!, user.id, seconds ?? null, rest || null, ctx.author.id);
        const how = ctx.t(rec.type === 'role' ? 'viaRole' : 'viaTimeout');
        await ctx.reply(
          rec.until
            ? ctx.t('muted', { user: name(user), duration: humanizeSeconds((rec.until - Date.now()) / 1000), how })
            : ctx.t('mutedForever', { user: name(user), how }),
        );
      },
    });

    cog.command({
      name: 'unmute',
      description: 'Hebt eine Server-Stummschaltung auf.',
      guildOnly: true,
      permissions: { level: 'mod', member: ['ModerateMembers'] },
      options: [
        { name: 'user', description: 'Mitglied', type: OptionType.User, required: true },
        { name: 'grund', description: 'Grund', type: OptionType.String, rest: true },
      ],
      run: async (ctx) => {
        const user = ctx.arg<ResolvedUser>('user');
        const ok = await serverUnmute(ctx.guildId!, user.id, ctx.arg<string | undefined>('grund') ?? null, ctx.author.id);
        await ctx.reply(ok ? ctx.t('unmuted', { user: name(user) }) : ctx.t('notMuted', { user: name(user) }));
      },
    });

    cog.command({
      name: 'channelmute',
      description: 'Schaltet ein Mitglied nur in diesem Kanal stumm.',
      guildOnly: true,
      permissions: { level: 'mod', member: ['ManageRoles'] },
      options: userAndRest,
      run: async (ctx) => {
        const user = ctx.arg<ResolvedUser>('user');
        checkTarget(ctx, user.id);
        const { seconds, rest } = takeDuration(ctx.arg<string | undefined>('rest') ?? '');
        const channel = p().getChannel(ctx.channelId);
        const prev = channel?.permission_overwrites?.find((o) => o.id === user.id);
        const allow = prev ? BigInt(prev.allow) & ~MUTE_DENY : 0n;
        const deny = (prev ? BigInt(prev.deny) : 0n) | MUTE_DENY;
        await p().setChannelOverwrite(ctx.channelId, user.id, { type: 1, allow, deny }, rest || undefined);
        const until = seconds ? Date.now() + seconds * 1000 : 0;
        cog.config.custom('cmute', ctx.guildId!, ctx.channelId, user.id).setAll({
          until,
          reason: rest || null,
          prevAllow: prev ? prev.allow : null,
          prevDeny: prev ? prev.deny : null,
          moderatorId: ctx.author.id,
        });
        await modlog()?.createCase({ guildId: ctx.guildId!, action: 'channelmute', targetId: user.id, moderatorId: ctx.author.id, reason: rest || null, until: until || null });
        await ctx.reply(
          until
            ? ctx.t('channelMuted', { user: name(user), channel: `<#${ctx.channelId}>`, duration: humanizeSeconds(seconds!) })
            : ctx.t('channelMutedForever', { user: name(user), channel: `<#${ctx.channelId}>` }),
        );
      },
    });

    cog.command({
      name: 'channelunmute',
      description: 'Hebt die Stummschaltung in diesem Kanal auf.',
      guildOnly: true,
      permissions: { level: 'mod', member: ['ManageRoles'] },
      options: [
        { name: 'user', description: 'Mitglied', type: OptionType.User, required: true },
        { name: 'grund', description: 'Grund', type: OptionType.String, rest: true },
      ],
      run: async (ctx) => {
        const user = ctx.arg<ResolvedUser>('user');
        const ok = await channelUnmute(ctx.guildId!, ctx.channelId, user.id, ctx.arg<string | undefined>('grund') ?? null, ctx.author.id);
        await ctx.reply(ok ? ctx.t('channelUnmuted', { user: name(user) }) : ctx.t('notMuted', { user: name(user) }));
      },
    });

    cog.command({
      name: 'activemutes',
      description: 'Zeigt alle aktiven Stummschaltungen.',
      aliases: ['mutes'],
      guildOnly: true,
      permissions: { level: 'mod', member: ['ModerateMembers'] },
      run: async (ctx) => {
        const prefix = `${ctx.guildId}:`;
        const lines: string[] = [];
        for (const [key, rec] of Object.entries(cog.config.allCustom<ServerMute & Record<string, unknown>>('mute'))) {
          if (!key.startsWith(prefix)) continue;
          lines.push(`🔇 <@${key.slice(prefix.length)}> – ${rec.until ? formatDateTime(rec.until) : ctx.t('common.forever')} – ${rec.reason ?? '–'}`);
        }
        for (const [key, rec] of Object.entries(cog.config.allCustom<ChannelMute & Record<string, unknown>>('cmute'))) {
          if (!key.startsWith(prefix)) continue;
          const [channelId, userId] = key.slice(prefix.length).split(':');
          lines.push(`#️⃣ <@${userId}> in <#${channelId}> – ${rec.until ? formatDateTime(rec.until) : ctx.t('common.forever')} – ${rec.reason ?? '–'}`);
        }
        await ctx.sendEmbed({ title: ctx.t('activeTitle'), description: lines.join('\n').slice(0, 4000) || ctx.t('none') });
      },
    });

    cog.group({
      name: 'muteset',
      description: 'Einstellungen für Stummschaltungen.',
      guildOnly: true,
      permissions: { level: 'admin', member: ['ManageGuild'] },
      subcommands: [
        {
          name: 'role',
          description: 'Mute-Rolle festlegen (ohne Angabe: Timeout statt Rolle verwenden).',
          options: [{ name: 'rolle', description: 'Rolle', type: OptionType.Role }],
          run: async (ctx) => {
            const role = ctx.arg<APIRole | undefined>('rolle');
            cog.config.guild(ctx.guildId!).set('muteRole', role?.id ?? null);
            await ctx.reply(role ? ctx.t('roleSet', { role: role.name }) : ctx.t('roleCleared'));
          },
        },
        {
          name: 'makerole',
          description: 'Erstellt eine Mute-Rolle und sperrt sie in allen Kanälen.',
          permissions: { level: 'admin', member: ['ManageRoles'], bot: ['ManageRoles'] },
          options: [{ name: 'name', description: 'Rollenname', type: OptionType.String, rest: true, default: 'Stummgeschaltet' }],
          run: async (ctx) => {
            await ctx.typing();
            const role = await p().createRole(ctx.guildId!, { name: ctx.arg<string>('name'), permissions: '0' }, 'muteset makerole');
            let ok = 0;
            let failed = 0;
            for (const channel of ctx.guild?.channels.values() ?? []) {
              if (![0, 2, 4, 5, 15].includes(Number(channel.type))) continue;
              try {
                await p().setChannelOverwrite(channel.id, role.id, { type: 0, allow: 0n, deny: MUTE_DENY }, 'muteset makerole');
                ok++;
              } catch {
                failed++;
              }
            }
            cog.config.guild(ctx.guildId!).set('muteRole', role.id);
            await ctx.reply(ctx.t('roleMade', { role: role.name, ok, failed }));
          },
        },
        {
          name: 'defaulttime',
          description: 'Standarddauer, wenn keine angegeben wird ("aus" = dauerhaft bzw. 28 Tage Timeout).',
          options: [{ name: 'dauer', description: 'z. B. 1h oder aus', type: OptionType.String, required: true }],
          run: async (ctx) => {
            const raw = ctx.arg<string>('dauer');
            const off = ['aus', 'off', 'none', 'reset'].includes(raw.toLowerCase());
            const seconds = off ? null : takeDuration(raw).seconds;
            if (!off && !seconds) throw new UserError(ctx.t('badDuration'));
            cog.config.guild(ctx.guildId!).set('defaultTime', seconds ?? null);
            await ctx.reply(seconds ? ctx.t('defaultSet', { duration: humanizeSeconds(seconds) }) : ctx.t('defaultCleared'));
          },
        },
        {
          name: 'dm',
          description: 'Betroffene per DM benachrichtigen.',
          options: [{ name: 'aktiv', description: 'an/aus', type: OptionType.Boolean, required: true }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('dm', ctx.arg<boolean>('aktiv'));
            await ctx.tick();
          },
        },
      ],
    });

    // Sticky: Wer stummgeschaltet den Server verlässt und zurückkommt, bekommt die Rolle wieder.
    cog.on('GUILD_MEMBER_ADD', async (m: { guild_id: string; user: { id: string } }) => {
      const rec = cog.config.custom('mute', m.guild_id, m.user.id).raw() as Partial<ServerMute>;
      if (rec.type === 'role' && rec.roleId && (!rec.until || rec.until > Date.now())) {
        await p().addRole(m.guild_id, m.user.id, rec.roleId, cog.tg(m.guild_id, 'stickyReason')).catch(() => undefined);
      }
    });

    cog.schedule({
      name: 'mute-ablauf',
      every: 30,
      run: async () => {
        const now = Date.now();
        for (const [key, rec] of Object.entries(cog.config.allCustom<ServerMute & Record<string, unknown>>('mute'))) {
          if (!rec.until || rec.until > now) continue;
          const [guildId, userId] = key.split(':') as [string, string];
          await serverUnmute(guildId, userId, cog.tg(guildId, 'expired'), cog.platform.user?.id ?? null).catch((err) =>
            cog.log.warn({ err, guildId, userId }, 'Stummschaltung konnte nicht aufgehoben werden'),
          );
        }
        for (const [key, rec] of Object.entries(cog.config.allCustom<ChannelMute & Record<string, unknown>>('cmute'))) {
          if (!rec.until || rec.until > now) continue;
          const [guildId, channelId, userId] = key.split(':') as [string, string, string];
          await channelUnmute(guildId, channelId, userId, cog.tg(guildId, 'expired'), cog.platform.user?.id ?? null).catch((err) =>
            cog.log.warn({ err, guildId, userId }, 'Kanal-Stummschaltung konnte nicht aufgehoben werden'),
          );
        }
      },
    });
  },
});
