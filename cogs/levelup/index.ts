import {
  defineCog,
  embed,
  formatNumber,
  humanizeSeconds,
  OptionType,
  pagify,
  UserError,
  type APIMessage,
  type APIRole,
  type Cog,
  type CommandContext,
  type ResolvedUser,
} from '@bot/sdk';

/** XP, die von Level l auf l+1 nötig sind (MEE6-Formel). */
export function xpForNext(level: number): number {
  return 5 * level * level + 50 * level + 100;
}

/** Gesamt-XP → Level und Fortschritt im aktuellen Level. */
export function levelFromXp(xp: number): { level: number; current: number; needed: number } {
  let level = 0;
  let rest = Math.max(0, xp);
  while (rest >= xpForNext(level)) {
    rest -= xpForNext(level);
    level++;
  }
  return { level, current: rest, needed: xpForNext(level) };
}

/** Gesamt-XP, die man für ein Level braucht. */
export function totalXpForLevel(level: number): number {
  let sum = 0;
  for (let l = 0; l < level; l++) sum += xpForNext(l);
  return sum;
}

export function progressBar(current: number, needed: number, width = 12): string {
  const filled = Math.round((current / Math.max(1, needed)) * width);
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

export interface LevelStats {
  xp: number;
  level: number;
  current: number;
  needed: number;
  rank: number;
  messages: number;
  voiceSeconds: number;
}

/** Schnittstelle für andere Cogs (badges, Profile). */
export interface LevelupApi {
  stats(guildId: string, userId: string): LevelStats;
  addXp(guildId: string, userId: string, xp: number): Promise<number>;
}

export default defineCog({
  setup(cog: Cog) {
    const T = cog.tablePrefix + 'xp';
    cog.migrate([
      `CREATE TABLE IF NOT EXISTS ${T} (
        guild_id TEXT NOT NULL, user_id TEXT NOT NULL, xp INTEGER NOT NULL DEFAULT 0,
        messages INTEGER NOT NULL DEFAULT 0, voice_seconds INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, user_id))`,
      `CREATE INDEX IF NOT EXISTS ${T}_rank ON ${T} (guild_id, xp DESC)`,
    ]);
    cog.config.registerGuild({
      enabled: true,
      xpMin: 15,
      xpMax: 25,
      cooldown: 60,
      announce: 'here' as 'here' | 'channel' | 'dm' | 'off',
      announceChannel: null as string | null,
      message: '🎉 {user} ist jetzt **Level {level}**!',
      ignoredChannels: [] as string[],
      ignoredRoles: [] as string[],
      voiceXp: true,
      voiceXpPerMinute: 5,
      roleRewards: {} as Record<string, string>,
      stackRoles: true,
    });

    const db = cog.db;
    const q = {
      get: db.prepare(`SELECT xp, messages, voice_seconds FROM ${T} WHERE guild_id = ? AND user_id = ?`),
      add: db.prepare(
        `INSERT INTO ${T} (guild_id, user_id, xp, messages, voice_seconds) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (guild_id, user_id) DO UPDATE SET xp = MAX(0, xp + excluded.xp), messages = messages + excluded.messages, voice_seconds = voice_seconds + excluded.voice_seconds`,
      ),
      setXp: db.prepare(
        `INSERT INTO ${T} (guild_id, user_id, xp) VALUES (?, ?, ?) ON CONFLICT (guild_id, user_id) DO UPDATE SET xp = excluded.xp`,
      ),
      rank: db.prepare(`SELECT COUNT(*) + 1 AS rank FROM ${T} WHERE guild_id = ? AND xp > ?`),
      top: db.prepare(`SELECT user_id, xp FROM ${T} WHERE guild_id = ? AND xp > 0 ORDER BY xp DESC LIMIT 200`),
      resetUser: db.prepare(`DELETE FROM ${T} WHERE guild_id = ? AND user_id = ?`),
      resetGuild: db.prepare(`DELETE FROM ${T} WHERE guild_id = ?`),
    };
    const p = () => cog.platform;
    const lastMessage = new Map<string, number>();

    const stats = (guildId: string, userId: string): LevelStats => {
      const row = (q.get.get(guildId, userId) as { xp: number; messages: number; voice_seconds: number } | undefined) ?? { xp: 0, messages: 0, voice_seconds: 0 };
      const lv = levelFromXp(row.xp);
      return { xp: row.xp, ...lv, rank: (q.rank.get(guildId, row.xp) as { rank: number }).rank, messages: row.messages, voiceSeconds: row.voice_seconds };
    };

    /** Level-Rollen anpassen (bei stackRoles alle erreichten, sonst nur die höchste). */
    async function syncRoles(guildId: string, userId: string, level: number): Promise<void> {
      const conf = cog.config.guild(guildId);
      const rewards = Object.entries(conf.get<Record<string, string>>('roleRewards'))
        .map(([lvl, role]) => ({ level: Number(lvl), role }))
        .sort((a, b) => a.level - b.level);
      if (!rewards.length) return;
      const member = p().getMember(guildId, userId);
      if (!member) return;
      const earned = rewards.filter((r) => r.level <= level);
      const keep = conf.get<boolean>('stackRoles') ? earned.map((r) => r.role) : earned.slice(-1).map((r) => r.role);
      for (const r of rewards) {
        const has = member.roles.includes(r.role);
        const should = keep.includes(r.role);
        if (should && !has) await p().addRole(guildId, userId, r.role, 'Level-Belohnung').catch(() => undefined);
        if (!should && has && !conf.get<boolean>('stackRoles')) await p().removeRole(guildId, userId, r.role, 'Level-Belohnung').catch(() => undefined);
      }
    }

    async function announce(guildId: string, userId: string, level: number, channelId?: string): Promise<void> {
      const conf = cog.config.guild(guildId);
      const mode = conf.get<string>('announce');
      if (mode === 'off') return;
      const text = conf.get<string>('message').replace(/\{user\}/g, `<@${userId}>`).replace(/\{level\}/g, String(level)).replace(/\{server\}/g, p().getGuild(guildId)?.name ?? '');
      const payload = { content: text, allowed_mentions: { users: [userId] } };
      if (mode === 'dm') await p().sendDM(userId, text).catch(() => undefined);
      else {
        const target = mode === 'channel' ? (conf.get<string | null>('announceChannel') ?? channelId) : channelId;
        if (target) await cog.bot.send(target, payload, guildId).catch(() => undefined);
      }
    }

    /** XP gutschreiben; bei Level-Aufstieg Rollen und Glückwunsch. Liefert das neue Level. */
    async function addXp(guildId: string, userId: string, xp: number, extra: { messages?: number; voiceSeconds?: number; channelId?: string } = {}): Promise<number> {
      const before = stats(guildId, userId).level;
      q.add.run(guildId, userId, Math.round(xp), extra.messages ?? 0, extra.voiceSeconds ?? 0);
      const after = stats(guildId, userId).level;
      if (after !== before) {
        await syncRoles(guildId, userId, after);
        if (after > before) {
          await announce(guildId, userId, after, extra.channelId);
          cog.emit('levelUp', { guildId, userId, level: after, previous: before });
        }
      }
      return after;
    }
    cog.expose<LevelupApi>({ stats, addXp: (g, u, xp) => addXp(g, u, xp) });

    const ignored = (guildId: string, channelId: string, userId: string): boolean => {
      const conf = cog.config.guild(guildId);
      const chans = conf.get<string[]>('ignoredChannels');
      const parent = p().getChannel(channelId)?.parent_id;
      if (chans.includes(channelId) || (parent && chans.includes(parent))) return true;
      const roles = conf.get<string[]>('ignoredRoles');
      return Boolean(p().getMember(guildId, userId)?.roles?.some((r) => roles.includes(r)));
    };

    cog.on('MESSAGE_CREATE', async (m: APIMessage) => {
      const g = m.guild_id;
      if (!g || !m.author || (m.author as { bot?: boolean }).bot || m.webhook_id) return;
      const conf = cog.config.guild(g);
      if (!conf.get<boolean>('enabled') || ignored(g, m.channel_id, m.author.id)) return;
      // Befehle zählen nicht
      if (cog.bot.prefixesFor(g).some((pre) => (m.content ?? '').startsWith(pre))) return;
      const key = `${g}:${m.author.id}`;
      const now = Date.now();
      if (now - (lastMessage.get(key) ?? 0) < conf.get<number>('cooldown') * 1000) {
        q.add.run(g, m.author.id, 0, 1, 0); // Nachricht zählen, aber keine XP
        return;
      }
      lastMessage.set(key, now);
      const min = conf.get<number>('xpMin');
      const max = Math.max(min, conf.get<number>('xpMax'));
      await addXp(g, m.author.id, min + Math.floor(Math.random() * (max - min + 1)), { messages: 1, channelId: m.channel_id });
    });

    // Sprach-XP: jede Minute für alle, die in einem Kanal mit mindestens einer weiteren Person sind
    // und weder stumm noch taub geschaltet sind.
    cog.schedule({
      name: 'sprach-xp',
      every: 60,
      run: async () => {
        for (const guild of p().guilds.values()) {
          const conf = cog.config.guild(guild.id);
          if (!conf.get<boolean>('enabled') || !conf.get<boolean>('voiceXp')) continue;
          const perChannel = new Map<string, string[]>();
          for (const vs of guild.voiceStates.values()) {
            if (!vs.channel_id) continue;
            const isBot = (guild.members.get(vs.user_id)?.user as { bot?: boolean } | undefined)?.bot;
            if (isBot) continue;
            const list = perChannel.get(vs.channel_id) ?? [];
            list.push(vs.user_id);
            perChannel.set(vs.channel_id, list);
          }
          for (const [channelId, users] of perChannel) {
            if (users.length < 2 || channelId === guild.afk_channel_id) continue;
            for (const userId of users) {
              const vs = guild.voiceStates.get(userId)!;
              if (vs.self_mute || vs.self_deaf || vs.mute || vs.deaf || ignored(guild.id, channelId, userId)) continue;
              await addXp(guild.id, userId, conf.get<number>('voiceXpPerMinute'), { voiceSeconds: 60 });
            }
          }
        }
      },
    });

    // ------------------------------------------------------------------ Befehle
    cog.command({
      name: 'rank',
      description: 'Zeigt Level und XP.',
      aliases: ['level', 'xp'],
      guildOnly: true,
      options: [{ name: 'user', description: 'Mitglied (Standard: du)', type: OptionType.User }],
      run: async (ctx) => {
        const user = ctx.arg<ResolvedUser | undefined>('user') ?? { id: ctx.author.id, user: ctx.author };
        const s = stats(ctx.guildId!, user.id);
        await ctx.sendEmbed({
          title: ctx.t('rankTitle', { name: user.user?.username ?? user.id }),
          description: `**Level ${s.level}** – ${ctx.t('rankPlace', { rank: s.rank })}\n${progressBar(s.current, s.needed)} ${formatNumber(s.current)}/${formatNumber(s.needed)} XP`,
          fields: [
            { name: ctx.t('totalXp'), value: formatNumber(s.xp), inline: true },
            { name: ctx.t('messages'), value: formatNumber(s.messages), inline: true },
            { name: ctx.t('voice'), value: humanizeSeconds(s.voiceSeconds, 2), inline: true },
          ],
          color: 0x9b59b6,
        });
      },
    });

    cog.command({
      name: 'levels',
      description: 'Rangliste nach XP.',
      aliases: ['lb', 'top'],
      guildOnly: true,
      run: async (ctx) => {
        const rows = (q.top.all(ctx.guildId) as Array<{ user_id: string; xp: number }>).filter((r) => ctx.guild?.members.has(r.user_id) ?? true);
        if (!rows.length) return ctx.reply(ctx.t('noXp'));
        const lines = rows.map((r, i) => `**${i + 1}.** <@${r.user_id}> – Level ${levelFromXp(r.xp).level} (${formatNumber(r.xp)} XP)`);
        await ctx.paginate(pagify(lines.join('\n'), { pageLength: 1500 }).map((pg) => embed({ title: ctx.t('boardTitle', { server: ctx.guild?.name ?? '' }), description: pg, color: 0x9b59b6 })));
      },
    });

    const admin = { level: 'admin', member: ['ManageGuild'] } as const;
    const setBool = (key: string, description: string) => ({
      name: key.toLowerCase(),
      description,
      options: [{ name: 'aktiv', description: 'an/aus', type: OptionType.Boolean, required: true }],
      run: async (ctx: CommandContext) => {
        cog.config.guild(ctx.guildId!).set(key, ctx.arg<boolean>('aktiv'));
        await ctx.tick();
      },
    });

    cog.group({
      name: 'levelset',
      description: 'Einstellungen für Levels.',
      guildOnly: true,
      permissions: admin,
      run: async (ctx) => {
        const c = cog.config.guild(ctx.guildId!).all() as Record<string, unknown>;
        const rewards = Object.entries(c.roleRewards as Record<string, string>)
          .sort(([a], [b]) => Number(a) - Number(b))
          .map(([l, r]) => `Level ${l} → <@&${r}>`);
        await ctx.sendEmbed({
          title: ctx.t('settingsTitle'),
          fields: [
            { name: ctx.t('s.enabled'), value: c.enabled ? '✅' : '❌', inline: true },
            { name: ctx.t('s.xp'), value: `${c.xpMin}–${c.xpMax} / ${c.cooldown}s`, inline: true },
            { name: ctx.t('s.voice'), value: c.voiceXp ? `✅ ${c.voiceXpPerMinute} XP/min` : '❌', inline: true },
            { name: ctx.t('s.announce'), value: `${ctx.t(`modes.${c.announce}`)}${c.announceChannel ? ` → <#${c.announceChannel}>` : ''}`, inline: true },
            { name: ctx.t('s.message'), value: String(c.message) },
            { name: ctx.t('s.roles'), value: rewards.join('\n') || '–' },
          ],
        });
      },
      subcommands: [
        setBool('enabled', 'Levels an/aus.'),
        setBool('voiceXp', 'XP für Zeit im Sprachkanal.'),
        setBool('stackRoles', 'Alle erreichten Level-Rollen behalten (aus = nur die höchste).'),
        {
          name: 'xp',
          description: 'XP pro Nachricht (zufällig zwischen min und max).',
          options: [
            { name: 'min', description: 'Minimum', type: OptionType.Integer, required: true, min_value: 0, max_value: 1000 },
            { name: 'max', description: 'Maximum', type: OptionType.Integer, required: true, min_value: 0, max_value: 1000 },
          ],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).setAll({ xpMin: Math.min(ctx.arg<number>('min'), ctx.arg<number>('max')), xpMax: Math.max(ctx.arg<number>('min'), ctx.arg<number>('max')) });
            await ctx.tick();
          },
        },
        {
          name: 'cooldown',
          description: 'Sekunden, bis eine Nachricht wieder XP gibt.',
          options: [{ name: 'sekunden', description: 'Sekunden', type: OptionType.Integer, required: true, min_value: 0, max_value: 3600 }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('cooldown', ctx.arg<number>('sekunden'));
            await ctx.tick();
          },
        },
        {
          name: 'voicerate',
          description: 'XP pro Minute im Sprachkanal.',
          options: [{ name: 'xp', description: 'XP', type: OptionType.Integer, required: true, min_value: 0, max_value: 1000 }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('voiceXpPerMinute', ctx.arg<number>('xp'));
            await ctx.tick();
          },
        },
        {
          name: 'announce',
          description: 'Wo Level-Aufstiege verkündet werden.',
          options: [
            {
              name: 'modus',
              description: 'hier, kanal, dm oder aus',
              type: OptionType.String,
              required: true,
              choices: [
                { name: 'hier', value: 'here' },
                { name: 'kanal', value: 'channel' },
                { name: 'dm', value: 'dm' },
                { name: 'aus', value: 'off' },
              ],
            },
            { name: 'kanal', description: 'Kanal (bei "kanal")', type: OptionType.Channel, channel_types: [0, 5] },
          ],
          run: async (ctx) => {
            const mode = ctx.arg<string>('modus');
            const ch = ctx.arg<{ id: string } | undefined>('kanal');
            if (mode === 'channel' && !ch) throw new UserError(ctx.t('needChannel'));
            cog.config.guild(ctx.guildId!).setAll({ announce: mode, announceChannel: ch?.id ?? null });
            await ctx.tick();
          },
        },
        {
          name: 'message',
          description: 'Glückwunschtext ({user}, {level}, {server}).',
          options: [{ name: 'text', description: 'Text', type: OptionType.String, required: true, rest: true, max_length: 500 }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('message', ctx.arg<string>('text'));
            await ctx.tick();
          },
        },
        {
          name: 'ignore',
          description: 'Kanal/Kategorie oder Rolle von XP ausnehmen (umschalten).',
          options: [{ name: 'ziel', description: '#kanal oder @rolle', type: OptionType.String, required: true }],
          run: async (ctx) => {
            const raw = ctx.arg<string>('ziel');
            const ch = /^<#(\d+)>$/.exec(raw)?.[1];
            const role = /^<@&(\d+)>$/.exec(raw)?.[1];
            const key = ch ? 'ignoredChannels' : role ? 'ignoredRoles' : null;
            if (!key) throw new UserError(ctx.t('badIgnore'));
            const id = (ch ?? role)!;
            let now = false;
            cog.config.guild(ctx.guildId!).update<string[]>(key, (l) => {
              now = !l.includes(id);
              return now ? [...l, id] : l.filter((x) => x !== id);
            });
            await ctx.reply(ctx.t(now ? 'ignoreOn' : 'ignoreOff'));
          },
        },
        {
          name: 'role',
          description: 'Level-Rollen.',
          subcommands: [
            {
              name: 'add',
              description: 'Rolle ab einem Level vergeben.',
              options: [
                { name: 'level', description: 'Level', type: OptionType.Integer, required: true, min_value: 1, max_value: 1000 },
                { name: 'rolle', description: 'Rolle', type: OptionType.Role, required: true },
              ],
              run: async (ctx) => {
                cog.config.guild(ctx.guildId!).update<Record<string, string>>('roleRewards', (r) => ({ ...r, [String(ctx.arg<number>('level'))]: ctx.arg<APIRole>('rolle').id }));
                await ctx.tick();
              },
            },
            {
              name: 'remove',
              description: 'Level-Rolle entfernen.',
              options: [{ name: 'level', description: 'Level', type: OptionType.Integer, required: true }],
              run: async (ctx) => {
                cog.config.guild(ctx.guildId!).update<Record<string, string>>('roleRewards', (r) => {
                  const { [String(ctx.arg<number>('level'))]: _gone, ...rest } = r;
                  return rest;
                });
                await ctx.tick();
              },
            },
          ],
        },
        {
          name: 'setlevel',
          description: 'Level eines Mitglieds setzen.',
          options: [
            { name: 'user', description: 'Mitglied', type: OptionType.User, required: true },
            { name: 'level', description: 'Level', type: OptionType.Integer, required: true, min_value: 0, max_value: 1000 },
          ],
          run: async (ctx) => {
            const user = ctx.arg<ResolvedUser>('user');
            q.setXp.run(ctx.guildId, user.id, totalXpForLevel(ctx.arg<number>('level')));
            await syncRoles(ctx.guildId!, user.id, ctx.arg<number>('level'));
            await ctx.tick();
          },
        },
        {
          name: 'addxp',
          description: 'XP hinzufügen (negativ = abziehen).',
          options: [
            { name: 'user', description: 'Mitglied', type: OptionType.User, required: true },
            { name: 'xp', description: 'XP', type: OptionType.Integer, required: true },
          ],
          run: async (ctx) => {
            const user = ctx.arg<ResolvedUser>('user');
            const level = await addXp(ctx.guildId!, user.id, ctx.arg<number>('xp'), { channelId: ctx.channelId });
            await ctx.reply(ctx.t('xpAdded', { user: `<@${user.id}>`, level }));
          },
        },
        {
          name: 'reset',
          description: 'XP eines Mitglieds oder des ganzen Servers zurücksetzen.',
          options: [{ name: 'user', description: 'Mitglied (leer = alle)', type: OptionType.User }],
          run: async (ctx) => {
            const user = ctx.arg<ResolvedUser | undefined>('user');
            if (!(await ctx.confirm(ctx.t(user ? 'resetUserConfirm' : 'resetAllConfirm', { user: user ? `<@${user.id}>` : '' })))) return ctx.reply(ctx.t('common.cancelled'));
            if (user) q.resetUser.run(ctx.guildId, user.id);
            else q.resetGuild.run(ctx.guildId);
            await ctx.tick();
          },
        },
      ],
    });
  },
});
