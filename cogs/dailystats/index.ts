import {
  defineCog,
  embed,
  formatNumber,
  humanizeSeconds,
  OptionType,
  UserError,
  type APIEmbed,
  type APIMessage,
  type APIVoiceState,
  type Cog,
  type CommandContext,
  type ReactionEvent,
  type ResolvedUser,
} from '@bot/sdk';

export const EMOJI_RE = /<a?:\w+:\d+>|\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*/gu;

/** Lokales Datum (Bot-Zeitzone) als YYYY-MM-DD. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}
export function percentChange(now: number, before: number): string {
  if (before === 0) return now === 0 ? '±0 %' : 'neu';
  const p = Math.round(((now - before) / before) * 100);
  return `${p > 0 ? '+' : p < 0 ? '−' : '±'}${Math.abs(p)} %`;
}

type Kind =
  | 'msg_user'
  | 'msg_channel'
  | 'msg_user_channel'
  | 'hour'
  | 'hour_user'
  | 'emoji'
  | 'emoji_user'
  | 'voice_user'
  | 'voice_channel'
  | 'joins'
  | 'leaves';

interface Range {
  from: string;
  to: string;
}

const WEEKDAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

export default defineCog({
  setup(cog: Cog) {
    const T = cog.tablePrefix + 'counts';
    cog.migrate([
      `CREATE TABLE IF NOT EXISTS ${T} (guild_id TEXT NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, value INTEGER NOT NULL,
        PRIMARY KEY (guild_id, day, kind, key))`,
      `CREATE INDEX IF NOT EXISTS ${T}_kind ON ${T} (guild_id, kind, day)`,
    ]);
    cog.config.registerGuild({
      enabled: true,
      channel: null as string | null,
      daily: true,
      dailyTime: '22:00',
      weekly: true,
      weeklyDay: 0,
      weeklyTime: '18:00',
      yearly: true,
      lastDaily: '',
      lastWeekly: '',
      lastYearly: '',
    });
    cog.config.registerUser({ optout: false });
    const db = cog.db;
    const q = {
      add: db.prepare(
        `INSERT INTO ${T} (guild_id, day, kind, key, value) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (guild_id, day, kind, key) DO UPDATE SET value = value + excluded.value`,
      ),
      top: db.prepare(`SELECT key, SUM(value) AS v FROM ${T} WHERE guild_id = ? AND kind = ? AND day BETWEEN ? AND ? GROUP BY key ORDER BY v DESC LIMIT ?`),
      total: db.prepare(`SELECT COALESCE(SUM(value), 0) AS v FROM ${T} WHERE guild_id = ? AND kind = ? AND day BETWEEN ? AND ?`),
      prefixTop: db.prepare(
        `SELECT key, SUM(value) AS v FROM ${T} WHERE guild_id = ? AND kind = ? AND day BETWEEN ? AND ? AND key LIKE ? ESCAPE '\\' GROUP BY key ORDER BY v DESC LIMIT ?`,
      ),
      all: db.prepare(`SELECT key, SUM(value) AS v FROM ${T} WHERE guild_id = ? AND kind = ? AND day BETWEEN ? AND ? GROUP BY key`),
      deleteUser: db.prepare(`DELETE FROM ${T} WHERE (kind IN ('msg_user','voice_user') AND key = ?) OR (kind IN ('msg_user_channel','hour_user','emoji_user') AND key LIKE ? ESCAPE '\\')`),
      deleteGuild: db.prepare(`DELETE FROM ${T} WHERE guild_id = ?`),
      prune: db.prepare(`DELETE FROM ${T} WHERE day < ?`),
    };
    const p = () => cog.platform;
    const optedOut = (userId: string) => cog.config.user(userId).get<boolean>('optout');
    const add = (guildId: string, kind: Kind, key: string, n = 1, date = new Date()) => q.add.run(guildId, dayKey(date), kind, key, n);
    const enabled = (guildId: string) => cog.config.guild(guildId).get<boolean>('enabled');

    // ------------------------------------------------------------------ Erfassen (nur Zähler)
    cog.on('MESSAGE_CREATE', (m: APIMessage) => {
      const g = m.guild_id;
      if (!g || !m.author || (m.author as { bot?: boolean }).bot || m.webhook_id || !enabled(g)) return;
      const u = m.author.id;
      if (optedOut(u)) return;
      // Bot-Befehle zählen nicht als Aktivität (wie bei levelup)
      if (cog.bot.prefixesFor(g).some((pre) => (m.content ?? '').startsWith(pre))) return;
      const now = new Date();
      const hour = String(now.getHours());
      db.transaction(() => {
        add(g, 'msg_user', u, 1, now);
        add(g, 'msg_channel', m.channel_id, 1, now);
        add(g, 'msg_user_channel', `${u}:${m.channel_id}`, 1, now);
        add(g, 'hour', hour, 1, now);
        add(g, 'hour_user', `${u}:${hour}`, 1, now);
        for (const e of (m.content ?? '').match(EMOJI_RE) ?? []) {
          add(g, 'emoji', e, 1, now);
          add(g, 'emoji_user', `${u}:${e}`, 1, now);
        }
      })();
    });

    cog.on('MESSAGE_REACTION_ADD', (r: ReactionEvent) => {
      if (!r.guild_id || r.user_id === p().user?.id || !enabled(r.guild_id) || optedOut(r.user_id)) return;
      const e = r.emoji.id ? `<:${r.emoji.name}:${r.emoji.id}>` : (r.emoji.name ?? '');
      if (!e) return;
      add(r.guild_id, 'emoji', e);
      add(r.guild_id, 'emoji_user', `${r.user_id}:${e}`);
    });

    cog.on('GUILD_MEMBER_ADD', (m: { guild_id: string; user: { bot?: boolean } }) => {
      if (!m.user.bot && enabled(m.guild_id)) add(m.guild_id, 'joins', '');
    });
    cog.on('GUILD_MEMBER_REMOVE', (d: { guild_id: string; user: { bot?: boolean } }) => {
      if (!d.user.bot && enabled(d.guild_id)) add(d.guild_id, 'leaves', '');
    });

    // Sprachzeit: laufende Sitzungen, regelmäßig gutgeschrieben (damit Tage sauber getrennt werden)
    const sessions = new Map<string, { channel: string; start: number }>();
    const credit = (key: string, until = Date.now()) => {
      const s = sessions.get(key);
      if (!s) return;
      const [g, u] = key.split(':') as [string, string];
      const secs = Math.floor((until - s.start) / 1000);
      if (secs > 0 && enabled(g) && !optedOut(u)) {
        add(g, 'voice_user', u, secs);
        add(g, 'voice_channel', s.channel, secs);
      }
      s.start = until;
    };
    const trackable = (g: string, vs: Pick<APIVoiceState, 'channel_id' | 'user_id'>) => {
      if (!vs.channel_id || vs.channel_id === p().getGuild(g)?.afk_channel_id) return false;
      const bot = (p().getMember(g, vs.user_id)?.user as { bot?: boolean } | undefined)?.bot;
      return !bot && vs.user_id !== p().user?.id;
    };
    cog.on('VOICE_STATE_UPDATE', (vs: APIVoiceState) => {
      const g = vs.guild_id;
      if (!g) return;
      const key = `${g}:${vs.user_id}`;
      credit(key);
      sessions.delete(key);
      if (trackable(g, vs)) sessions.set(key, { channel: vs.channel_id!, start: Date.now() });
    });
    cog.onReady(() => {
      for (const guild of p().guilds.values()) {
        for (const vs of guild.voiceStates.values()) {
          if (trackable(guild.id, vs)) sessions.set(`${guild.id}:${vs.user_id}`, { channel: vs.channel_id!, start: Date.now() });
        }
      }
    });
    cog.onUnload(() => {
      for (const key of sessions.keys()) credit(key);
    });

    // ------------------------------------------------------------------ Auswertung
    const top = (g: string, kind: Kind, r: Range, limit = 5) => q.top.all(g, kind, r.from, r.to, limit) as Array<{ key: string; v: number }>;
    const total = (g: string, kind: Kind, r: Range) => (q.total.get(g, kind, r.from, r.to) as { v: number }).v;
    const allOf = (g: string, kind: Kind, r: Range) => q.all.all(g, kind, r.from, r.to) as Array<{ key: string; v: number }>;
    const userKeys = (g: string, kind: Kind, r: Range, userId: string, limit = 3) =>
      (q.prefixTop.all(g, kind, r.from, r.to, `${userId.replace(/[\\%_]/g, '\\$&')}:%`, limit) as Array<{ key: string; v: number }>).map((x) => ({ key: x.key.slice(userId.length + 1), v: x.v }));
    const mentionList = (rows: Array<{ key: string; v: number }>, fmt: (v: number) => string) => {
      const medals = ['🥇', '🥈', '🥉'];
      return rows.map((r, i) => `${medals[i] ?? `${i + 1}.`} <@${r.key}> – ${fmt(r.v)}`).join('\n') || '–';
    };
    const hourLabel = (h: string | undefined) => (h === undefined ? '–' : `${h.padStart(2, '0')}–${String((Number(h) + 1) % 24).padStart(2, '0')} Uhr`);

    /** Bester Wert über Benutzer:Stunde-Schlüssel in einem Stundenfenster. */
    const bestInHours = (g: string, r: Range, hours: number[]): { user: string; v: number } | null => {
      const sums = new Map<string, number>();
      for (const row of allOf(g, 'hour_user', r)) {
        const [u, h] = row.key.split(':') as [string, string];
        if (hours.includes(Number(h))) sums.set(u, (sums.get(u) ?? 0) + row.v);
      }
      const best = [...sums.entries()].sort((a, b) => b[1] - a[1])[0];
      return best && best[1] >= 3 ? { user: best[0], v: best[1] } : null;
    };
    const channelHopper = (g: string, r: Range): { user: string; v: number } | null => {
      const counts = new Map<string, number>();
      for (const row of allOf(g, 'msg_user_channel', r)) {
        const u = row.key.split(':')[0]!;
        counts.set(u, (counts.get(u) ?? 0) + 1);
      }
      const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      return best && best[1] >= 3 ? { user: best[0], v: best[1] } : null;
    };
    const emojiFan = (g: string, r: Range): { user: string; v: number } | null => {
      const counts = new Map<string, number>();
      for (const row of allOf(g, 'emoji_user', r)) {
        const u = row.key.split(':')[0]!;
        counts.set(u, (counts.get(u) ?? 0) + row.v);
      }
      const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      return best && best[1] >= 5 ? { user: best[0], v: best[1] } : null;
    };

    function dailyEmbed(g: string, day: Date): APIEmbed {
      const r = { from: dayKey(day), to: dayKey(day) };
      const y = { from: dayKey(addDays(day, -1)), to: dayKey(addDays(day, -1)) };
      const msgs = total(g, 'msg_user', r);
      const voice = total(g, 'voice_user', r);
      const emoji = top(g, 'emoji', r, 1)[0];
      const hour = top(g, 'hour', r, 1)[0];
      const t = (k: string, v?: Record<string, string | number>) => cog.tg(g, k, v);
      return embed({
        title: t('daily.title', { date: day.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' }) }),
        description: t('daily.summary', { msgs: formatNumber(msgs), change: percentChange(msgs, total(g, 'msg_user', y)), voice: humanizeSeconds(voice, 2) }),
        fields: [
          { name: t('f.topUsers'), value: mentionList(top(g, 'msg_user', r, 5), (v) => t('nMsgs', { count: v })), inline: true },
          { name: t('f.topChannels'), value: top(g, 'msg_channel', r, 3).map((c, i) => `${i + 1}. <#${c.key}> – ${formatNumber(c.v)}`).join('\n') || '–', inline: true },
          { name: t('f.voice'), value: mentionList(top(g, 'voice_user', r, 3), (v) => humanizeSeconds(v, 2)) },
          { name: t('f.emoji'), value: emoji ? `${emoji.key} ×${emoji.v}` : '–', inline: true },
          { name: t('f.hour'), value: hourLabel(hour?.key), inline: true },
          { name: t('f.members'), value: `+${total(g, 'joins', r)} / −${total(g, 'leaves', r)}`, inline: true },
        ],
        color: 0x3498db,
      });
    }

    /** Wrapped für einen Zeitraum (Woche/Jahr) mit Vergleich zum Vorzeitraum und Awards. */
    function wrappedEmbeds(g: string, r: Range, prev: Range, kind: 'week' | 'year'): APIEmbed[] {
      const t = (k: string, v?: Record<string, string | number>) => cog.tg(g, k, v);
      const msgs = total(g, 'msg_user', r);
      const prevMsgs = total(g, 'msg_user', prev);
      const voice = total(g, 'voice_user', r);
      const prevVoice = total(g, 'voice_user', prev);
      const joins = total(g, 'joins', r);
      const leaves = total(g, 'leaves', r);
      const emoji = top(g, 'emoji', r, 3);
      const hour = top(g, 'hour', r, 1)[0];
      const talker = top(g, 'msg_user', r, 1)[0];
      const voiceChamp = top(g, 'voice_user', r, 1)[0];
      const owl = bestInHours(g, r, [0, 1, 2, 3, 4]);
      const bird = bestInHours(g, r, [5, 6, 7, 8]);
      const hopper = channelHopper(g, r);
      const fan = emojiFan(g, r);
      const awards = [
        talker && t('awards.talker', { user: `<@${talker.key}>`, n: formatNumber(talker.v) }),
        voiceChamp && t('awards.voice', { user: `<@${voiceChamp.key}>`, time: humanizeSeconds(voiceChamp.v, 2) }),
        owl && t('awards.owl', { user: `<@${owl.user}>`, n: owl.v }),
        bird && t('awards.bird', { user: `<@${bird.user}>`, n: bird.v }),
        hopper && t('awards.hopper', { user: `<@${hopper.user}>`, n: hopper.v }),
        fan && t('awards.emoji', { user: `<@${fan.user}>`, n: fan.v }),
      ].filter(Boolean) as string[];
      const main = embed({
        title: t(`wrapped.${kind}Title`, { server: p().getGuild(g)?.name ?? '' }),
        description: t('wrapped.intro', {
          msgs: formatNumber(msgs),
          msgChange: percentChange(msgs, prevMsgs),
          voice: humanizeSeconds(voice, 2),
          voiceChange: percentChange(voice, prevVoice),
          joins,
          leaves,
        }),
        fields: [
          { name: t('f.topUsers'), value: mentionList(top(g, 'msg_user', r, 5), (v) => t('nMsgs', { count: v })), inline: true },
          { name: t('f.topChannels'), value: top(g, 'msg_channel', r, 5).map((c, i) => `${i + 1}. <#${c.key}> – ${formatNumber(c.v)}`).join('\n') || '–', inline: true },
          { name: t('f.voiceChamps'), value: mentionList(top(g, 'voice_user', r, 3), (v) => humanizeSeconds(v, 2)) },
          { name: t('f.favEmoji'), value: emoji.map((e) => `${e.key} ×${e.v}`).join('  ') || '–', inline: true },
          { name: t('f.hour'), value: hourLabel(hour?.key), inline: true },
        ],
        color: 0x1db954,
      });
      const awardsEmbed = embed({ title: t('wrapped.awardsTitle'), description: awards.join('\n') || t('wrapped.noAwards'), color: 0x1db954, footer: t('wrapped.footer') });
      return [main, awardsEmbed];
    }

    function personalEmbed(g: string, userId: string, name: string, r: Range, label: string): APIEmbed {
      const t = (k: string, v?: Record<string, string | number>) => cog.tg(g, k, v);
      const msgs = (top(g, 'msg_user', r, 10_000).find((x) => x.key === userId)?.v) ?? 0;
      const ranking = top(g, 'msg_user', r, 10_000);
      const rank = ranking.findIndex((x) => x.key === userId) + 1;
      const voice = top(g, 'voice_user', r, 10_000).find((x) => x.key === userId)?.v ?? 0;
      const channels = userKeys(g, 'msg_user_channel', r, userId, 3);
      const hours = userKeys(g, 'hour_user', r, userId, 1);
      const emojis = userKeys(g, 'emoji_user', r, userId, 3);
      return embed({
        title: t('personal.title', { name, period: label }),
        description: msgs || voice ? t('personal.intro', { msgs: formatNumber(msgs), rank: rank || '–', total: ranking.length, voice: humanizeSeconds(voice, 2) }) : t('personal.nothing'),
        fields: [
          { name: t('f.yourChannels'), value: channels.map((c, i) => `${i + 1}. <#${c.key}> – ${formatNumber(c.v)}`).join('\n') || '–', inline: true },
          { name: t('f.yourHour'), value: hourLabel(hours[0]?.key), inline: true },
          { name: t('f.yourEmojis'), value: emojis.map((e) => `${e.key} ×${e.v}`).join('  ') || '–', inline: true },
        ],
        color: 0x1db954,
      });
    }

    const rangeFor = (period: string, now = new Date()): { r: Range; label: string } => {
      if (period === 'jahr') return { r: { from: `${now.getFullYear()}-01-01`, to: dayKey(now) }, label: String(now.getFullYear()) };
      if (period === 'monat') return { r: { from: dayKey(addDays(now, -29)), to: dayKey(now) }, label: cog.t('periods.month') };
      if (period === 'heute') return { r: { from: dayKey(now), to: dayKey(now) }, label: cog.t('periods.today') };
      return { r: { from: dayKey(addDays(now, -6)), to: dayKey(now) }, label: cog.t('periods.week') };
    };

    async function post(g: string, embeds: APIEmbed[]): Promise<void> {
      const channel = cog.config.guild(g).get<string | null>('channel');
      if (!channel) return;
      await cog.bot.send(channel, { ...(await cog.bot.adaptPayload({ embeds, allowed_mentions: { parse: [] } }, g, channel)) }, g).catch((err) => cog.log.warn({ err, g }, 'Statistik konnte nicht gepostet werden'));
    }

    // ------------------------------------------------------------------ Zeitplan
    cog.schedule({
      name: 'sprachzeit',
      every: 300,
      run: () => {
        for (const key of sessions.keys()) credit(key);
      },
    });
    cog.schedule({
      name: 'posts',
      every: 60,
      run: async () => {
        const now = new Date();
        const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        const today = dayKey(now);
        for (const g of p().guilds.keys()) {
          const c = cog.config.guild(g);
          if (!c.get<boolean>('enabled') || !c.get<string | null>('channel')) continue;
          for (const key of sessions.keys()) if (key.startsWith(`${g}:`)) credit(key);
          if (c.get<boolean>('daily') && hm >= c.get<string>('dailyTime') && c.get<string>('lastDaily') !== today) {
            c.set('lastDaily', today);
            await post(g, [dailyEmbed(g, now)]);
          }
          if (c.get<boolean>('weekly') && now.getDay() === c.get<number>('weeklyDay') && hm >= c.get<string>('weeklyTime') && c.get<string>('lastWeekly') !== today) {
            c.set('lastWeekly', today);
            const r = { from: dayKey(addDays(now, -6)), to: today };
            const prev = { from: dayKey(addDays(now, -13)), to: dayKey(addDays(now, -7)) };
            await post(g, wrappedEmbeds(g, r, prev, 'week'));
          }
          if (c.get<boolean>('yearly') && now.getMonth() === 11 && now.getDate() === 31 && hm >= c.get<string>('weeklyTime') && c.get<string>('lastYearly') !== today) {
            c.set('lastYearly', today);
            const y = now.getFullYear();
            await post(g, wrappedEmbeds(g, { from: `${y}-01-01`, to: today }, { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` }, 'year'));
          }
        }
      },
    });
    cog.schedule({ name: 'aufraeumen', cron: '30 3 * * *', run: () => void q.prune.run(dayKey(addDays(new Date(), -400))) });

    // ------------------------------------------------------------------ Befehle
    cog.command({
      name: 'wrapped',
      description: 'Deine persönliche Statistik (Woche, Monat oder Jahr).',
      guildOnly: true,
      options: [
        {
          name: 'zeitraum',
          description: 'woche, monat, jahr oder heute',
          type: OptionType.String,
          default: 'woche',
          choices: ['woche', 'monat', 'jahr', 'heute'].map((x) => ({ name: x, value: x })),
        },
        { name: 'user', description: 'Mitglied (Standard: du)', type: OptionType.User },
      ],
      run: async (ctx) => {
        const user = ctx.arg<ResolvedUser | undefined>('user') ?? { id: ctx.author.id, user: ctx.author };
        if (optedOut(user.id)) throw new UserError(ctx.t('optedOutInfo'));
        const { r, label } = rangeFor(ctx.arg<string>('zeitraum'));
        for (const key of sessions.keys()) if (key === `${ctx.guildId}:${user.id}`) credit(key);
        await ctx.sendEmbed(personalEmbed(ctx.guildId!, user.id, user.user?.username ?? user.id, r, label));
      },
    });

    cog.group({
      name: 'stats',
      description: 'Server-Statistiken.',
      guildOnly: true,
      subcommands: [
        {
          name: 'today',
          description: 'Tageszusammenfassung (Vorschau).',
          aliases: ['heute'],
          run: async (ctx) => {
            for (const key of sessions.keys()) if (key.startsWith(`${ctx.guildId}:`)) credit(key);
            await ctx.sendEmbed(dailyEmbed(ctx.guildId!, new Date()));
          },
        },
        {
          name: 'week',
          description: 'Wrapped der letzten 7 Tage (Vorschau).',
          aliases: ['woche'],
          run: async (ctx) => {
            const now = new Date();
            const embeds = wrappedEmbeds(ctx.guildId!, { from: dayKey(addDays(now, -6)), to: dayKey(now) }, { from: dayKey(addDays(now, -13)), to: dayKey(addDays(now, -7)) }, 'week');
            await ctx.send(await ctx.bot.adaptPayload({ embeds, allowed_mentions: { parse: [] } }, ctx.guildId, ctx.channelId));
          },
        },
        {
          name: 'year',
          description: 'Jahresrückblick bis heute.',
          aliases: ['jahr'],
          run: async (ctx) => {
            const now = new Date();
            const y = now.getFullYear();
            const embeds = wrappedEmbeds(ctx.guildId!, { from: `${y}-01-01`, to: dayKey(now) }, { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` }, 'year');
            await ctx.send(await ctx.bot.adaptPayload({ embeds, allowed_mentions: { parse: [] } }, ctx.guildId, ctx.channelId));
          },
        },
        {
          name: 'optout',
          description: 'Mich nicht mehr erfassen.',
          run: async (ctx) => {
            cog.config.user(ctx.author.id).set('optout', true);
            sessions.forEach((_, k) => k.endsWith(`:${ctx.author.id}`) && sessions.delete(k));
            await ctx.reply(ctx.t('optedOut', { prefix: ctx.prefix }));
          },
        },
        {
          name: 'optin',
          description: 'Mich wieder erfassen.',
          run: async (ctx) => {
            cog.config.user(ctx.author.id).set('optout', false);
            await ctx.reply(ctx.t('optedIn'));
          },
        },
        {
          name: 'delete',
          description: 'Alle meine gespeicherten Zähler löschen (alle Server).',
          aliases: ['löschen'],
          run: async (ctx) => {
            if (!(await ctx.confirm(ctx.t('deleteConfirm')))) return ctx.reply(ctx.t('common.cancelled'));
            const n = q.deleteUser.run(ctx.author.id, `${ctx.author.id.replace(/[\\%_]/g, '\\$&')}:%`).changes;
            await ctx.reply(ctx.t('deleted', { count: n }));
          },
        },
      ],
    });

    const admin = { level: 'admin', member: ['ManageGuild'] } as const;
    const timeOpt = { name: 'uhrzeit', description: 'HH:MM', type: OptionType.String, required: true } as const;
    const parseTime = (ctx: CommandContext, raw: string) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(raw);
      if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new UserError(ctx.t('badTime'));
      return `${m[1]!.padStart(2, '0')}:${m[2]}`;
    };
    cog.group({
      name: 'statsset',
      description: 'Statistiken einrichten.',
      guildOnly: true,
      permissions: admin,
      run: async (ctx) => {
        const c = cog.config.guild(ctx.guildId!).all() as Record<string, unknown>;
        await ctx.sendEmbed({
          title: ctx.t('settingsTitle'),
          description: ctx.t('settingsBody', {
            enabled: c.enabled ? '✅' : '❌',
            channel: c.channel ? `<#${c.channel}>` : '–',
            daily: c.daily ? `✅ ${c.dailyTime}` : '❌',
            weekly: c.weekly ? `✅ ${WEEKDAYS[c.weeklyDay as number]} ${c.weeklyTime}` : '❌',
            yearly: c.yearly ? '✅' : '❌',
          }),
        });
      },
      subcommands: [
        {
          name: 'channel',
          description: 'Kanal für Tageszusammenfassung und Wrapped.',
          options: [{ name: 'kanal', description: 'Kanal', type: OptionType.Channel, required: true, channel_types: [0, 5] }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('channel', ctx.arg<{ id: string }>('kanal').id);
            await ctx.tick();
          },
        },
        {
          name: 'daily',
          description: 'Uhrzeit der Tageszusammenfassung ("aus" = keine).',
          options: [timeOpt],
          run: async (ctx) => {
            const raw = ctx.arg<string>('uhrzeit');
            if (['aus', 'off'].includes(raw.toLowerCase())) cog.config.guild(ctx.guildId!).set('daily', false);
            else cog.config.guild(ctx.guildId!).setAll({ daily: true, dailyTime: parseTime(ctx, raw) });
            await ctx.tick();
          },
        },
        {
          name: 'weekly',
          description: 'Tag und Uhrzeit des Wrapped ("aus" = keins).',
          options: [
            { name: 'tag', description: 'Wochentag (z. B. Sonntag) oder aus', type: OptionType.String, required: true },
            { name: 'uhrzeit', description: 'HH:MM', type: OptionType.String },
          ],
          run: async (ctx) => {
            const day = ctx.arg<string>('tag').toLowerCase();
            if (['aus', 'off'].includes(day)) {
              cog.config.guild(ctx.guildId!).set('weekly', false);
              return ctx.tick();
            }
            const idx = WEEKDAYS.findIndex((w) => w.toLowerCase().startsWith(day.slice(0, 2)));
            if (idx < 0) throw new UserError(ctx.t('badDay'));
            const time = ctx.arg<string | undefined>('uhrzeit');
            cog.config.guild(ctx.guildId!).setAll({ weekly: true, weeklyDay: idx, ...(time ? { weeklyTime: parseTime(ctx, time) } : {}) });
            await ctx.tick();
          },
        },
        {
          name: 'yearly',
          description: 'Jahresrückblick am 31.12.',
          options: [{ name: 'aktiv', description: 'an/aus', type: OptionType.Boolean, required: true }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('yearly', ctx.arg<boolean>('aktiv'));
            await ctx.tick();
          },
        },
        {
          name: 'toggle',
          description: 'Erfassung auf diesem Server an/aus.',
          options: [{ name: 'aktiv', description: 'an/aus', type: OptionType.Boolean, required: true }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('enabled', ctx.arg<boolean>('aktiv'));
            await ctx.tick();
          },
        },
        {
          name: 'reset',
          description: 'Alle Statistiken dieses Servers löschen.',
          permissions: { level: 'guildowner', member: ['Administrator'] },
          run: async (ctx) => {
            if (!(await ctx.confirm(ctx.t('resetConfirm')))) return ctx.reply(ctx.t('common.cancelled'));
            q.deleteGuild.run(ctx.guildId);
            await ctx.tick();
          },
        },
      ],
    });
  },
});
