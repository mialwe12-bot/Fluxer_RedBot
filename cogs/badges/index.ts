import { defineCog, formatDateTime, OptionType, UserError, type Cog, type CommandContext, type ResolvedUser } from '@bot/sdk';
import type { EconomyApi } from '../economy/index.js';
import type { LevelupApi } from '../levelup/index.js';
import { progressBar } from '../levelup/index.js';

interface Badge {
  name: string;
  emoji: string;
  description: string;
  autoLevel: number | null;
}

export default defineCog({
  setup(cog: Cog) {
    cog.config.registerGuild({ badges: {} as Record<string, Badge> });
    cog.config.registerMember({ badges: [] as string[] });
    const all = (g: string) => cog.config.guild(g).get<Record<string, Badge>>('badges');
    const owned = (g: string, u: string) => cog.config.member(g, u).get<string[]>('badges').filter((b) => all(g)[b]);

    const give = (g: string, u: string, key: string): boolean => {
      let added = false;
      cog.config.member(g, u).update<string[]>('badges', (l) => {
        added = !l.includes(key);
        return added ? [...l, key] : l;
      });
      return added;
    };

    // Automatisch vergeben, wenn levelup einen Aufstieg meldet
    cog.on('levelUp', async (e: { guildId: string; userId: string; level: number }) => {
      for (const [key, b] of Object.entries(all(e.guildId))) {
        if (b.autoLevel !== null && e.level >= b.autoLevel && give(e.guildId, e.userId, key)) {
          await cog.platform.sendDM(e.userId, cog.tg(e.guildId, 'autoAwarded', { badge: `${b.emoji} ${b.name}`, server: cog.platform.getGuild(e.guildId)?.name ?? '' })).catch(() => undefined);
        }
      }
    });

    const findBadge = (ctx: CommandContext, raw: string): [string, Badge] => {
      const key = raw.toLowerCase();
      const b = all(ctx.guildId!)[key];
      if (!b) throw new UserError(ctx.t('notFound', { badge: raw }));
      return [key, b];
    };
    const userOpt = { name: 'user', description: 'Mitglied', type: OptionType.User, required: true } as const;
    const badgeOpt = { name: 'abzeichen', description: 'Name des Abzeichens', type: OptionType.String, required: true } as const;

    cog.command({
      name: 'badges',
      description: 'Zeigt die Abzeichen eines Mitglieds.',
      aliases: ['abzeichen'],
      guildOnly: true,
      options: [{ name: 'user', description: 'Mitglied (Standard: du)', type: OptionType.User }],
      run: async (ctx) => {
        const user = ctx.arg<ResolvedUser | undefined>('user') ?? { id: ctx.author.id, user: ctx.author };
        const list = owned(ctx.guildId!, user.id).map((k) => all(ctx.guildId!)[k]!);
        if (!list.length) return ctx.reply(ctx.t('noBadges', { user: `<@${user.id}>` }));
        await ctx.sendEmbed({ title: ctx.t('userTitle', { name: user.user?.username ?? user.id }), description: list.map((b) => `${b.emoji} **${b.name}** – ${b.description}`).join('\n'), color: 0xf1c40f });
      },
    });

    cog.command({
      name: 'profile',
      description: 'Profil mit Level, Guthaben und Abzeichen.',
      aliases: ['profil'],
      guildOnly: true,
      options: [{ name: 'user', description: 'Mitglied (Standard: du)', type: OptionType.User }],
      run: async (ctx) => {
        const user = ctx.arg<ResolvedUser | undefined>('user') ?? { id: ctx.author.id, user: ctx.author, member: ctx.member };
        const member = user.member ?? ctx.bot.platform.getMember(ctx.guildId!, user.id);
        const fields: Array<{ name: string; value: string; inline?: boolean }> = [];
        const lv = ctx.bot.cogApi<LevelupApi>('levelup')?.stats(ctx.guildId!, user.id);
        if (lv) fields.push({ name: ctx.t('level'), value: `**${lv.level}** (${ctx.t('place', { rank: lv.rank })})\n${progressBar(lv.current, lv.needed, 10)}`, inline: true });
        const eco = ctx.bot.cogApi<EconomyApi>('economy');
        if (eco) fields.push({ name: ctx.t('balance'), value: eco.format(ctx.guildId!, eco.balance(ctx.guildId!, user.id)), inline: true });
        if (member?.joined_at) fields.push({ name: ctx.t('joined'), value: formatDateTime(new Date(member.joined_at)), inline: true });
        const badges = owned(ctx.guildId!, user.id).map((k) => all(ctx.guildId!)[k]!);
        fields.push({ name: ctx.t('badgesField', { count: badges.length }), value: badges.map((b) => b.emoji).join(' ') || '–' });
        await ctx.sendEmbed({ title: member?.nick ?? user.user?.username ?? user.id, fields, color: 0x9b59b6 });
      },
    });

    cog.group({
      name: 'badgeset',
      description: 'Abzeichen verwalten.',
      guildOnly: true,
      permissions: { level: 'admin', member: ['ManageGuild'] },
      run: async (ctx) => {
        const list = Object.values(all(ctx.guildId!));
        await ctx.sendEmbed({
          title: ctx.t('allTitle'),
          description: list.map((b) => `${b.emoji} **${b.name}** – ${b.description}${b.autoLevel !== null ? ` (${ctx.t('fromLevel', { level: b.autoLevel })})` : ''}`).join('\n') || ctx.t('none'),
        });
      },
      subcommands: [
        {
          name: 'create',
          description: 'Neues Abzeichen anlegen.',
          options: [
            { name: 'name', description: 'Name (ein Wort)', type: OptionType.String, required: true, max_length: 32 },
            { name: 'emoji', description: 'Emoji', type: OptionType.String, required: true },
            { name: 'beschreibung', description: 'Beschreibung', type: OptionType.String, required: true, rest: true, max_length: 200 },
          ],
          examples: ['badgeset create Veteran 🎖️ Seit über einem Jahr dabei'],
          run: async (ctx) => {
            const key = ctx.arg<string>('name').toLowerCase();
            if (all(ctx.guildId!)[key]) throw new UserError(ctx.t('exists'));
            cog.config.guild(ctx.guildId!).update<Record<string, Badge>>('badges', (b) => ({
              ...b,
              [key]: { name: ctx.arg<string>('name'), emoji: ctx.arg<string>('emoji'), description: ctx.arg<string>('beschreibung'), autoLevel: null },
            }));
            await ctx.tick();
          },
        },
        {
          name: 'delete',
          description: 'Abzeichen löschen.',
          options: [badgeOpt],
          run: async (ctx) => {
            const [key] = findBadge(ctx, ctx.arg<string>('abzeichen'));
            cog.config.guild(ctx.guildId!).update<Record<string, Badge>>('badges', (b) => {
              const { [key]: _gone, ...rest } = b;
              return rest;
            });
            await ctx.tick();
          },
        },
        {
          name: 'give',
          description: 'Abzeichen vergeben.',
          options: [userOpt, badgeOpt],
          run: async (ctx) => {
            const [key, b] = findBadge(ctx, ctx.arg<string>('abzeichen'));
            const user = ctx.arg<ResolvedUser>('user');
            const added = give(ctx.guildId!, user.id, key);
            await ctx.reply(added ? ctx.t('given', { badge: `${b.emoji} ${b.name}`, user: `<@${user.id}>` }) : ctx.t('alreadyHas'));
          },
        },
        {
          name: 'take',
          description: 'Abzeichen wegnehmen.',
          options: [userOpt, badgeOpt],
          run: async (ctx) => {
            const [key] = findBadge(ctx, ctx.arg<string>('abzeichen'));
            cog.config.member(ctx.guildId!, ctx.arg<ResolvedUser>('user').id).update<string[]>('badges', (l) => l.filter((x) => x !== key));
            await ctx.tick();
          },
        },
        {
          name: 'autolevel',
          description: 'Automatisch ab einem Level vergeben (0 = aus, braucht den Cog levelup).',
          options: [badgeOpt, { name: 'level', description: 'Level (0 = aus)', type: OptionType.Integer, required: true, min_value: 0, max_value: 1000 }],
          run: async (ctx) => {
            const [key, b] = findBadge(ctx, ctx.arg<string>('abzeichen'));
            const level = ctx.arg<number>('level');
            cog.config.guild(ctx.guildId!).update<Record<string, Badge>>('badges', (all) => ({ ...all, [key]: { ...b, autoLevel: level || null } }));
            await ctx.reply(level && !ctx.bot.cogs.isLoaded('levelup') ? ctx.t('needLevelup') : ctx.t('autoSet'));
          },
        },
      ],
    });
  },
});
