import { defineCog, formatDateTime, humanizeSeconds, OptionType, takeDuration, UserError, type APIRole, type Cog, type CommandContext } from '@bot/sdk';
import type { ModlogApi } from '../modlog/index.js';

interface PresencePayload {
  user: { id: string };
  guild_id?: string;
  status?: string;
  activities?: Array<{ name: string; type: number }>;
}

/** Aktivitätstypen: 0 = spielt (Discord-kompatibel). Fluxer-Typen sind laut Typdefinition offen. */
const PLAYING = 0;

/** Verbotenes Spiel unter den Aktivitäten? Groß/Klein egal; "*" am Ende = beginnt mit. */
export function findBlacklisted(activities: Array<{ name: string; type: number }> | undefined, games: string[]): string | null {
  for (const a of activities ?? []) {
    if (a.type !== PLAYING || !a.name) continue;
    const name = a.name.toLowerCase().trim();
    for (const g of games) {
      const pat = g.toLowerCase().trim();
      if (pat.endsWith('*') ? name.startsWith(pat.slice(0, -1)) : name === pat) return a.name;
    }
  }
  return null;
}

export default defineCog({
  setup(cog: Cog) {
    cog.config.registerGuild({
      enabled: false,
      games: [] as string[],
      timeout: 600,
      ignoredRoles: [] as string[],
      dm: true,
      logChannel: null as string | null,
    });
    const p = () => cog.platform;
    const modlog = () => cog.bot.cogApi<ModlogApi>('modlog');
    /** Diagnose: Liefert Fluxer überhaupt Aktivitäten? */
    const seen = { presences: 0, withActivities: 0, lastActivity: null as null | { name: string; at: number } };
    const recently = new Map<string, number>();

    async function check(guildId: string, pr: PresencePayload): Promise<void> {
      const conf = cog.config.guild(guildId);
      if (!conf.get<boolean>('enabled')) return;
      const game = findBlacklisted(pr.activities, conf.get<string[]>('games'));
      if (!game) return;
      const userId = pr.user.id;
      const key = `${guildId}:${userId}`;
      if (Date.now() - (recently.get(key) ?? 0) < conf.get<number>('timeout') * 1000) return;
      const member = p().getMember(guildId, userId);
      if ((member?.user as { bot?: boolean } | undefined)?.bot) return;
      if (member?.roles?.some((r) => conf.get<string[]>('ignoredRoles').includes(r))) return;
      if (await cog.bot.isImmune(guildId, userId)) return;
      if (member?.communication_disabled_until && new Date(member.communication_disabled_until) > new Date()) return;
      recently.set(key, Date.now());
      const seconds = conf.get<number>('timeout');
      const until = new Date(Date.now() + seconds * 1000);
      const reason = cog.tg(guildId, 'reason', { game });
      try {
        await p().timeoutMember(guildId, userId, until, reason);
      } catch (err) {
        cog.log.warn({ err, guildId, userId }, 'Timeout für verbotenes Spiel fehlgeschlagen');
        return;
      }
      await modlog()?.createCase({ guildId, action: 'timeout', targetId: userId, moderatorId: p().user?.id ?? null, reason, until });
      if (conf.get<boolean>('dm')) {
        await p().sendDM(userId, cog.tg(guildId, 'dm', { game, server: p().getGuild(guildId)?.name ?? '', time: humanizeSeconds(seconds) })).catch(() => undefined);
      }
      const log = conf.get<string | null>('logChannel');
      if (log) await cog.bot.send(log, { content: cog.tg(guildId, 'log', { user: `<@${userId}>`, game, time: humanizeSeconds(seconds) }), allowed_mentions: { parse: [] } }, guildId).catch(() => undefined);
    }

    const handle = (pr: PresencePayload, guildId?: string) => {
      seen.presences++;
      const playing = pr.activities?.find((a) => a.type === PLAYING && a.name);
      if (playing) {
        seen.withActivities++;
        seen.lastActivity = { name: playing.name, at: Date.now() };
      }
      // Ohne guild_id: alle gemeinsamen Server prüfen
      const target = guildId ?? pr.guild_id;
      const guilds = target ? [target] : [...p().guilds.values()].filter((g) => g.members.has(pr.user.id)).map((g) => g.id);
      for (const g of guilds) void check(g, pr).catch((err) => cog.log.debug({ err }, 'gameblacklist'));
    };
    cog.on('PRESENCE_UPDATE', (d: PresencePayload) => handle(d));
    cog.on('PRESENCE_UPDATE_BULK', (d: { guild_id?: string; presences: PresencePayload[] }) => {
      for (const pr of d.presences ?? []) handle(pr, d.guild_id);
    });

    // ------------------------------------------------------------------ Befehle
    cog.group({
      name: 'gameblacklist',
      description: 'Verbotene Spiele verwalten.',
      aliases: ['gbl'],
      guildOnly: true,
      permissions: { level: 'admin', member: ['ManageGuild'] },
      run: async (ctx) => {
        const c = cog.config.guild(ctx.guildId!).all() as { enabled: boolean; games: string[]; timeout: number; ignoredRoles: string[]; dm: boolean };
        await ctx.sendEmbed({
          title: ctx.t('title'),
          fields: [
            { name: ctx.t('f.enabled'), value: c.enabled ? '✅' : '❌', inline: true },
            { name: ctx.t('f.timeout'), value: humanizeSeconds(c.timeout), inline: true },
            { name: ctx.t('f.dm'), value: c.dm ? '✅' : '❌', inline: true },
            { name: ctx.t('f.games'), value: c.games.map((g) => `\`${g}\``).join(', ') || '–' },
            { name: ctx.t('f.ignored'), value: c.ignoredRoles.map((r) => `<@&${r}>`).join(' ') || '–' },
          ],
          footer: ctx.t('footer'),
        });
      },
      subcommands: [
        {
          name: 'add',
          description: 'Spiel verbieten (exakter Name, * am Ende = beginnt mit).',
          options: [{ name: 'spiel', description: 'Spielname', type: OptionType.String, required: true, rest: true, max_length: 100 }],
          examples: ['gameblacklist add Fortnite', 'gameblacklist add Call of Duty*'],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).update<string[]>('games', (l) => [...new Set([...l, ctx.arg<string>('spiel').trim()])]);
            await ctx.tick();
          },
        },
        {
          name: 'remove',
          description: 'Spiel wieder erlauben.',
          options: [{ name: 'spiel', description: 'Spielname', type: OptionType.String, required: true, rest: true }],
          run: async (ctx) => {
            const name = ctx.arg<string>('spiel').trim().toLowerCase();
            cog.config.guild(ctx.guildId!).update<string[]>('games', (l) => l.filter((g) => g.toLowerCase() !== name));
            await ctx.tick();
          },
        },
        {
          name: 'toggle',
          description: 'An/aus.',
          permissions: { level: 'admin', member: ['ManageGuild'], bot: ['ModerateMembers'] },
          options: [{ name: 'aktiv', description: 'an/aus', type: OptionType.Boolean, required: true }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('enabled', ctx.arg<boolean>('aktiv'));
            await ctx.reply(ctx.arg<boolean>('aktiv') && seen.withActivities === 0 ? ctx.t('enabledNoData') : ctx.t('common.done'));
          },
        },
        {
          name: 'timeout',
          description: 'Dauer des Timeouts (z. B. 10m, 1h, max. 28 Tage).',
          options: [{ name: 'dauer', description: 'Dauer', type: OptionType.String, required: true }],
          run: async (ctx: CommandContext) => {
            const s = takeDuration(ctx.arg<string>('dauer')).seconds;
            if (!s || s < 10 || s > 28 * 86400) throw new UserError(ctx.t('badDuration'));
            cog.config.guild(ctx.guildId!).set('timeout', s);
            await ctx.tick();
          },
        },
        {
          name: 'ignore',
          description: 'Rolle ausnehmen (umschalten).',
          options: [{ name: 'rolle', description: 'Rolle', type: OptionType.Role, required: true }],
          run: async (ctx) => {
            const id = ctx.arg<APIRole>('rolle').id;
            cog.config.guild(ctx.guildId!).update<string[]>('ignoredRoles', (l) => (l.includes(id) ? l.filter((r) => r !== id) : [...l, id]));
            await ctx.tick();
          },
        },
        {
          name: 'dm',
          description: 'Betroffene per DM informieren.',
          options: [{ name: 'aktiv', description: 'an/aus', type: OptionType.Boolean, required: true }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('dm', ctx.arg<boolean>('aktiv'));
            await ctx.tick();
          },
        },
        {
          name: 'log',
          description: 'Log-Kanal (leer = keiner).',
          options: [{ name: 'kanal', description: 'Kanal', type: OptionType.Channel, channel_types: [0, 5] }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('logChannel', ctx.arg<{ id: string } | undefined>('kanal')?.id ?? null);
            await ctx.tick();
          },
        },
        {
          name: 'status',
          description: 'Diagnose: Liefert Fluxer überhaupt Spiel-Aktivitäten?',
          run: async (ctx) => {
            await ctx.reply(
              ctx.t('status', {
                presences: seen.presences,
                activities: seen.withActivities,
                last: seen.lastActivity ? `${seen.lastActivity.name} (${formatDateTime(seen.lastActivity.at)})` : '–',
              }) + (seen.withActivities === 0 ? `\n${ctx.t('noData')}` : ''),
            );
          },
        },
      ],
    });
  },
});
