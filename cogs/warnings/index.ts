import {
  defineCog,
  embed,
  formatDateTime,
  humanizeSeconds,
  OptionType,
  pagify,
  takeDuration,
  takeInteger,
  UserError,
  type Cog,
  type CommandContext,
  type ResolvedUser,
} from '@bot/sdk';
import type { ModlogApi } from '../modlog/index.js';
import type { MutesApi } from '../mutes/index.js';

interface WarningRow {
  id: number;
  guild_id: string;
  user_id: string;
  moderator_id: string;
  points: number;
  reason: string;
  created_at: number;
}
interface PresetReason {
  points: number;
  description: string;
}
type ActionType = 'kick' | 'ban' | 'timeout' | 'mute';
interface WarnAction {
  name: string;
  points: number;
  action: ActionType;
  duration: number | null;
}

/** Schnittstelle für andere Cogs (z. B. automod). */
export interface WarningsApi {
  warn(guildId: string, userId: string, moderatorId: string, points: number, reason: string): Promise<{ total: number; triggered: WarnAction | null }>;
  totalPoints(guildId: string, userId: string): number;
}

const ACTION_TYPES: ActionType[] = ['kick', 'ban', 'timeout', 'mute'];

export default defineCog({
  setup(cog: Cog) {
    const T = cog.tablePrefix + 'warnings';
    cog.migrate([
      `CREATE TABLE IF NOT EXISTS ${T} (
        id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, moderator_id TEXT NOT NULL,
        points INTEGER NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS ${T}_user ON ${T} (guild_id, user_id)`,
    ]);
    cog.config.registerGuild({
      reasons: {} as Record<string, PresetReason>,
      actions: [] as WarnAction[],
      dm: true,
      allowCustomReasons: true,
      showModerator: false,
      warnChannel: null as string | null,
    });
    const db = cog.db;
    const q = {
      insert: db.prepare(`INSERT INTO ${T} (guild_id, user_id, moderator_id, points, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)`),
      forUser: db.prepare(`SELECT * FROM ${T} WHERE guild_id = ? AND user_id = ? ORDER BY id`),
      total: db.prepare(`SELECT COALESCE(SUM(points), 0) AS total FROM ${T} WHERE guild_id = ? AND user_id = ?`),
      get: db.prepare(`SELECT * FROM ${T} WHERE guild_id = ? AND id = ?`),
      del: db.prepare(`DELETE FROM ${T} WHERE guild_id = ? AND id = ?`),
    };
    const p = () => cog.platform;
    const modlog = () => cog.bot.cogApi<ModlogApi>('modlog');
    const totalPoints = (g: string, u: string) => (q.total.get(g, u) as { total: number }).total;

    async function runAction(guildId: string, userId: string, a: WarnAction, reason: string): Promise<void> {
      const botId = p().user?.id ?? null;
      const audit = cog.tg(guildId, 'autoReason', { name: a.name, reason }).slice(0, 400);
      switch (a.action) {
        case 'kick':
          await p().kickMember(guildId, userId, audit);
          await modlog()?.createCase({ guildId, action: 'kick', targetId: userId, moderatorId: botId, reason: audit });
          break;
        case 'ban': {
          await p().banMember(guildId, userId, { reason: audit });
          await modlog()?.createCase({ guildId, action: 'ban', targetId: userId, moderatorId: botId, reason: audit });
          break;
        }
        case 'timeout': {
          const secs = Math.min(a.duration ?? 3600, 28 * 86400);
          const until = new Date(Date.now() + secs * 1000);
          await p().timeoutMember(guildId, userId, until, audit);
          await modlog()?.createCase({ guildId, action: 'timeout', targetId: userId, moderatorId: botId, reason: audit, until });
          break;
        }
        case 'mute': {
          const mutes = cog.bot.cogApi<MutesApi>('mutes');
          if (mutes) await mutes.mute(guildId, userId, a.duration, audit, botId ?? '');
          else {
            const until = new Date(Date.now() + Math.min(a.duration ?? 3600, 28 * 86400) * 1000);
            await p().timeoutMember(guildId, userId, until, audit);
          }
          break;
        }
      }
    }

    /** Verwarnung speichern, benachrichtigen und ggf. Eskalationsaktion ausführen. */
    async function warn(guildId: string, userId: string, moderatorId: string, points: number, reason: string) {
      const before = totalPoints(guildId, userId);
      q.insert.run(guildId, userId, moderatorId, points, reason, Date.now());
      const total = before + points;
      await modlog()?.createCase({ guildId, action: 'warning', targetId: userId, moderatorId, reason: `${reason} (${points} P.)` });
      const conf = cog.config.guild(guildId);
      const text = cog.tg(guildId, 'dmWarned', {
        server: p().getGuild(guildId)?.name ?? guildId,
        reason,
        points,
        total,
        moderator: conf.get<boolean>('showModerator') ? `\n${cog.tg(guildId, 'common.moderator')}: <@${moderatorId}>` : '',
      });
      const channel = conf.get<string | null>('warnChannel');
      if (channel) await cog.bot.send(channel, { content: `<@${userId}> ${text}`, allowed_mentions: { users: [userId] } }).catch(() => undefined);
      else if (conf.get<boolean>('dm')) await p().sendDM(userId, text).catch(() => undefined);
      // Höchste Schwelle, die mit dieser Verwarnung neu erreicht wurde
      const triggered =
        conf
          .get<WarnAction[]>('actions')
          .filter((a) => before < a.points && total >= a.points)
          .sort((a, b) => b.points - a.points)[0] ?? null;
      if (triggered) {
        try {
          await runAction(guildId, userId, triggered, reason);
        } catch (err) {
          cog.log.warn({ err, guildId, userId, action: triggered.action }, 'Eskalationsaktion fehlgeschlagen');
        }
      }
      return { total, triggered };
    }

    cog.expose<WarningsApi>({ warn, totalPoints });

    const isMod = async (ctx: CommandContext) => ['mod', 'admin', 'guildowner', 'owner'].includes(await ctx.bot.levelOf(ctx.guildId, ctx.author.id));

    cog.command({
      name: 'warn',
      description: 'Verwarnt ein Mitglied (optional mit Punkten oder vordefiniertem Grund).',
      guildOnly: true,
      permissions: { level: 'mod', member: ['KickMembers'] },
      options: [
        { name: 'user', description: 'Mitglied', type: OptionType.User, required: true },
        { name: 'grund', description: '[Punkte] Grund oder Name eines vordefinierten Grunds', type: OptionType.String, required: true, rest: true },
      ],
      examples: ['warn @Laut Spam', 'warn @Troll 3 Beleidigung', 'warn @Troll werbung'],
      run: async (ctx) => {
        const user = ctx.arg<ResolvedUser>('user');
        const problem = cog.bot.hierarchyProblem(ctx.guildId!, ctx.author.id, user.id);
        if (problem && problem !== 'hierarchy.botRole') throw new UserError(ctx.t(problem));
        const { value, rest } = takeInteger(ctx.arg<string>('grund'));
        const conf = cog.config.guild(ctx.guildId!);
        const preset = conf.get<Record<string, PresetReason>>('reasons')[rest.toLowerCase()];
        let points = value ?? 1;
        let reason = rest;
        if (preset) {
          points = value ?? preset.points;
          reason = preset.description;
        } else if (!conf.get<boolean>('allowCustomReasons')) {
          throw new UserError(ctx.t('customDisabled', { reasons: Object.keys(conf.get<Record<string, PresetReason>>('reasons')).join(', ') || '–' }));
        }
        if (!reason) throw new UserError(ctx.t('needReason'));
        if (points < 0 || points > 100) throw new UserError(ctx.t('badPoints'));
        const { total, triggered } = await warn(ctx.guildId!, user.id, ctx.author.id, points, reason);
        let text = ctx.t('warned', { user: `<@${user.id}>`, points, total });
        if (triggered) text += `\n${ctx.t('escalated', { action: ctx.t(`actionNames.${triggered.action}`), name: triggered.name })}`;
        await ctx.reply(text);
      },
    });

    cog.command({
      name: 'warnings',
      description: 'Zeigt Verwarnungen (eigene, oder als Mod die eines anderen).',
      aliases: ['mywarnings'],
      guildOnly: true,
      options: [{ name: 'user', description: 'Mitglied (nur für Mods)', type: OptionType.User }],
      run: async (ctx) => {
        const target = ctx.arg<ResolvedUser | undefined>('user');
        if (target && target.id !== ctx.author.id && !(await isMod(ctx))) throw new UserError(ctx.t('onlyOwn'));
        const userId = target?.id ?? ctx.author.id;
        const rows = q.forUser.all(ctx.guildId, userId) as WarningRow[];
        if (!rows.length) return ctx.reply(ctx.t('noWarnings', { user: `<@${userId}>` }));
        const showMod = (await isMod(ctx)) || cog.config.guild(ctx.guildId!).get<boolean>('showModerator');
        const lines = rows.map(
          (r) => `**#${r.id}** – ${r.points} P. – ${formatDateTime(r.created_at)}${showMod ? ` – <@${r.moderator_id}>` : ''}\n${r.reason}`,
        );
        const total = rows.reduce((s, r) => s + r.points, 0);
        await ctx.paginate(
          pagify(lines.join('\n\n'), { pageLength: 1800 }).map((page) =>
            embed({ title: ctx.t('listTitle', { total }), description: `<@${userId}>\n\n${page}`, color: 0xf1c40f }),
          ),
        );
      },
    });

    cog.command({
      name: 'unwarn',
      description: 'Entfernt eine Verwarnung.',
      guildOnly: true,
      permissions: { level: 'mod', member: ['KickMembers'] },
      options: [
        { name: 'user', description: 'Mitglied', type: OptionType.User, required: true },
        { name: 'id', description: 'Verwarnungs-Nummer', type: OptionType.Integer, required: true },
        { name: 'grund', description: 'Grund', type: OptionType.String, rest: true },
      ],
      run: async (ctx) => {
        const user = ctx.arg<ResolvedUser>('user');
        const row = q.get.get(ctx.guildId, ctx.arg<number>('id')) as WarningRow | undefined;
        if (!row || row.user_id !== user.id) throw new UserError(ctx.t('warningNotFound'));
        q.del.run(ctx.guildId, row.id);
        await modlog()?.createCase({ guildId: ctx.guildId!, action: 'unwarn', targetId: user.id, moderatorId: ctx.author.id, reason: ctx.arg<string | undefined>('grund') ?? row.reason });
        await ctx.reply(ctx.t('unwarned', { id: row.id, total: totalPoints(ctx.guildId!, user.id) }));
      },
    });

    cog.group({
      name: 'warnreason',
      description: 'Vordefinierte Verwarnungsgründe.',
      guildOnly: true,
      permissions: { level: 'admin', member: ['ManageGuild'] },
      subcommands: [
        {
          name: 'add',
          description: 'Legt einen Grund an.',
          options: [
            { name: 'name', description: 'Kurzname', type: OptionType.String, required: true, max_length: 32 },
            { name: 'punkte', description: 'Punkte', type: OptionType.Integer, required: true, min_value: 0, max_value: 100 },
            { name: 'beschreibung', description: 'Beschreibung', type: OptionType.String, required: true, rest: true },
          ],
          run: async (ctx) => {
            const name = ctx.arg<string>('name').toLowerCase();
            cog.config.guild(ctx.guildId!).update<Record<string, PresetReason>>('reasons', (r) => ({
              ...r,
              [name]: { points: ctx.arg<number>('punkte'), description: ctx.arg<string>('beschreibung') },
            }));
            await ctx.reply(ctx.t('reasonAdded', { name }));
          },
        },
        {
          name: 'delete',
          description: 'Löscht einen Grund.',
          aliases: ['del', 'remove'],
          options: [{ name: 'name', description: 'Kurzname', type: OptionType.String, required: true }],
          run: async (ctx) => {
            const name = ctx.arg<string>('name').toLowerCase();
            cog.config.guild(ctx.guildId!).update<Record<string, PresetReason>>('reasons', (r) => {
              const { [name]: _gone, ...rest } = r;
              return rest;
            });
            await ctx.tick();
          },
        },
        {
          name: 'list',
          description: 'Listet alle Gründe.',
          run: async (ctx) => {
            const reasons = Object.entries(cog.config.guild(ctx.guildId!).get<Record<string, PresetReason>>('reasons'));
            await ctx.sendEmbed({
              title: ctx.t('reasonsTitle'),
              description: reasons.map(([n, r]) => `\`${n}\` – ${r.points} P. – ${r.description}`).join('\n') || '–',
            });
          },
        },
      ],
    });

    cog.group({
      name: 'warnaction',
      description: 'Automatische Aktionen ab einer Punktzahl.',
      guildOnly: true,
      permissions: { level: 'admin', member: ['ManageGuild'] },
      subcommands: [
        {
          name: 'add',
          description: 'Legt eine Aktion an (kick, ban, timeout, mute).',
          options: [
            { name: 'name', description: 'Name', type: OptionType.String, required: true, max_length: 32 },
            { name: 'punkte', description: 'Ab Punkten', type: OptionType.Integer, required: true, min_value: 1 },
            { name: 'aktion', description: 'kick, ban, timeout, mute', type: OptionType.String, required: true, choices: ACTION_TYPES.map((a) => ({ name: a, value: a })) },
            { name: 'dauer', description: 'Dauer bei timeout/mute (z. B. 1h)', type: OptionType.String },
          ],
          examples: ['warnaction add stufe1 3 timeout 1h', 'warnaction add stufe2 6 kick', 'warnaction add stufe3 10 ban'],
          run: async (ctx) => {
            const raw = ctx.arg<string | undefined>('dauer');
            const duration = raw ? takeDuration(raw).seconds ?? null : null;
            if (raw && !duration) throw new UserError(ctx.t('badDuration'));
            const action: WarnAction = { name: ctx.arg<string>('name'), points: ctx.arg<number>('punkte'), action: ctx.arg<ActionType>('aktion'), duration };
            cog.config.guild(ctx.guildId!).update<WarnAction[]>('actions', (list) =>
              [...list.filter((a) => a.name !== action.name), action].sort((a, b) => a.points - b.points),
            );
            await ctx.reply(ctx.t('actionAdded', { name: action.name, points: action.points, action: ctx.t(`actionNames.${action.action}`) }));
          },
        },
        {
          name: 'delete',
          description: 'Löscht eine Aktion.',
          aliases: ['del', 'remove'],
          options: [{ name: 'name', description: 'Name', type: OptionType.String, required: true }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).update<WarnAction[]>('actions', (list) => list.filter((a) => a.name !== ctx.arg<string>('name')));
            await ctx.tick();
          },
        },
        {
          name: 'list',
          description: 'Listet alle Aktionen.',
          run: async (ctx) => {
            const actions = cog.config.guild(ctx.guildId!).get<WarnAction[]>('actions');
            await ctx.sendEmbed({
              title: ctx.t('actionsTitle'),
              description:
                actions
                  .map((a) => `**${a.name}** – ab ${a.points} P. → ${ctx.t(`actionNames.${a.action}`)}${a.duration ? ` (${humanizeSeconds(a.duration)})` : ''}`)
                  .join('\n') || '–',
            });
          },
        },
      ],
    });

    cog.group({
      name: 'warningset',
      description: 'Einstellungen für Verwarnungen.',
      guildOnly: true,
      permissions: { level: 'admin', member: ['ManageGuild'] },
      subcommands: [
        {
          name: 'dm',
          description: 'Verwarnte per DM informieren.',
          options: [{ name: 'aktiv', description: 'an/aus', type: OptionType.Boolean, required: true }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('dm', ctx.arg<boolean>('aktiv'));
            await ctx.tick();
          },
        },
        {
          name: 'customreasons',
          description: 'Freie Gründe erlauben (sonst nur vordefinierte).',
          options: [{ name: 'aktiv', description: 'an/aus', type: OptionType.Boolean, required: true }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('allowCustomReasons', ctx.arg<boolean>('aktiv'));
            await ctx.tick();
          },
        },
        {
          name: 'showmoderator',
          description: 'Verwarnten anzeigen, wer verwarnt hat.',
          options: [{ name: 'aktiv', description: 'an/aus', type: OptionType.Boolean, required: true }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('showModerator', ctx.arg<boolean>('aktiv'));
            await ctx.tick();
          },
        },
        {
          name: 'warnchannel',
          description: 'Verwarnungen in einem Kanal statt per DM ankündigen (ohne Angabe: DM).',
          options: [{ name: 'kanal', description: 'Kanal', type: OptionType.Channel, channel_types: [0, 5] }],
          run: async (ctx) => {
            const ch = ctx.arg<{ id: string } | undefined>('kanal');
            cog.config.guild(ctx.guildId!).set('warnChannel', ch?.id ?? null);
            await ctx.tick();
          },
        },
      ],
    });
  },
});
