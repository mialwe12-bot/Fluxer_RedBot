import { defineCog, embed, OptionType, UserError, type APIRole, type Cog, type CommandContext, type ResolvedUser } from '@bot/sdk';

export interface Birthday {
  day: number;
  month: number;
  year: number | null;
}

/** "24.12.", "24.12.2000", "24.12" oder "2000-12-24" → Birthday. */
export function parseBirthday(input: string, now = new Date()): Birthday | undefined {
  const t = input.trim();
  let d: number, m: number, y: number | null = null;
  const de = /^(\d{1,2})\.(\d{1,2})\.?(\d{4})?$/.exec(t);
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (de) [d, m, y] = [Number(de[1]), Number(de[2]), de[3] ? Number(de[3]) : null];
  else if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else return undefined;
  if (m < 1 || m > 12 || d < 1) return undefined;
  const maxDay = new Date(y ?? 2000, m, 0).getDate(); // 2000 = Schaltjahr → 29.2. erlaubt
  if (d > maxDay) return undefined;
  if (y !== null && (y < 1900 || y > now.getFullYear())) return undefined;
  return { day: d, month: m, year: y };
}

/** Hat jemand heute Geburtstag? 29.2. wird in Nicht-Schaltjahren am 28.2. gefeiert. */
export function isBirthdayOn(b: Birthday, date: Date): boolean {
  const day = date.getDate();
  const month = date.getMonth() + 1;
  if (b.month === month && b.day === day) return true;
  const leap = new Date(date.getFullYear(), 1, 29).getMonth() === 1;
  return !leap && b.month === 2 && b.day === 29 && month === 2 && day === 28;
}

/** Tage bis zum nächsten Geburtstag (0 = heute). */
export function daysUntil(b: Birthday, from: Date): number {
  const start = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  for (let i = 0; i <= 366; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    if (isBirthdayOn(b, d)) return i;
  }
  return 366;
}

const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const fmt = (b: Birthday) => `${b.day}. ${MONTHS[b.month - 1]}${b.year ? ` ${b.year}` : ''}`;

export default defineCog({
  setup(cog: Cog) {
    cog.config.registerUser({ birthday: null as Birthday | null });
    cog.config.registerGuild({
      enabled: true,
      channel: null as string | null,
      role: null as string | null,
      time: '09:00',
      message: '🎉 Alles Gute zum Geburtstag, {user}!{age}',
      reminder: false,
      lastRun: '' as string,
      lastReminder: '' as string,
    });
    /** Vergebene Geburtstagsrollen: guild:user → bis wann. */
    cog.config.registerCustom('role', { until: 0, roleId: '' });
    const p = () => cog.platform;
    const today = () => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const birthdayOf = (userId: string) => cog.config.user(userId).get<Birthday | null>('birthday');
    const membersWithBirthdays = (guildId: string): Array<{ userId: string; b: Birthday }> => {
      const g = p().getGuild(guildId);
      return Object.entries(cog.config.allUsers<{ birthday: Birthday | null }>())
        .filter(([u, d]) => d.birthday && (g?.members.has(u) ?? false))
        .map(([u, d]) => ({ userId: u, b: d.birthday! }));
    };

    async function celebrate(guildId: string, now: Date): Promise<number> {
      const conf = cog.config.guild(guildId);
      const channel = conf.get<string | null>('channel');
      const role = conf.get<string | null>('role');
      const kids = membersWithBirthdays(guildId).filter((x) => isBirthdayOn(x.b, now));
      for (const { userId, b } of kids) {
        const age = b.year ? now.getFullYear() - b.year : null;
        const text = conf
          .get<string>('message')
          .replace(/\{user\}/g, `<@${userId}>`)
          .replace(/\{age\}/g, age ? ` ${cog.tg(guildId, 'age', { age })}` : '')
          .replace(/\{server\}/g, p().getGuild(guildId)?.name ?? '');
        if (channel) await cog.bot.send(channel, { content: text, allowed_mentions: { users: [userId] } }, guildId).catch(() => undefined);
        if (role && p().getGuild(guildId)?.roles.has(role)) {
          await p().addRole(guildId, userId, role, cog.tg(guildId, 'roleReason')).catch((err) => cog.log.debug({ err }, 'Geburtstagsrolle fehlgeschlagen'));
          cog.config.custom('role', guildId, userId).setAll({ until: Date.now() + 24 * 3600_000, roleId: role });
        }
      }
      return kids.length;
    }

    /** Jede Minute: Glückwünsche zur eingestellten Uhrzeit, Rollen nach 24 h entfernen. */
    cog.schedule({
      name: 'geburtstage',
      every: 60,
      runOnStart: true,
      run: async () => {
        const now = new Date();
        const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        for (const guildId of p().guilds.keys()) {
          const conf = cog.config.guild(guildId);
          if (!conf.get<boolean>('enabled')) continue;
          // Zur Uhrzeit oder danach (z. B. nach einem Neustart), aber nur einmal pro Tag
          if (hm >= conf.get<string>('time') && conf.get<string>('lastRun') !== today()) {
            conf.set('lastRun', today());
            await celebrate(guildId, now);
          }
          if (conf.get<boolean>('reminder') && hm >= conf.get<string>('time') && conf.get<string>('lastReminder') !== today()) {
            conf.set('lastReminder', today());
            const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
            const soon = membersWithBirthdays(guildId).filter((x) => isBirthdayOn(x.b, tomorrow));
            const channel = conf.get<string | null>('channel');
            if (soon.length && channel) {
              await cog.bot
                .send(channel, { content: cog.tg(guildId, 'reminder', { users: soon.map((x) => `<@${x.userId}>`).join(', ') }), allowed_mentions: { parse: [] } }, guildId)
                .catch(() => undefined);
            }
          }
        }
        for (const [key, r] of Object.entries(cog.config.allCustom<{ until: number; roleId: string }>('role'))) {
          if (!r.until || r.until > Date.now()) continue;
          const [guildId, userId] = key.split(':') as [string, string];
          await p().removeRole(guildId, userId, r.roleId, cog.tg(guildId, 'roleReason')).catch(() => undefined);
          cog.config.custom('role', guildId, userId).clear();
        }
      },
    });

    // ------------------------------------------------------------------ Befehle
    cog.group({
      name: 'birthday',
      description: 'Geburtstage.',
      aliases: ['bday', 'geburtstag'],
      subcommands: [
        {
          name: 'set',
          description: 'Deinen Geburtstag speichern (TT.MM. oder TT.MM.JJJJ).',
          options: [{ name: 'datum', description: 'z. B. 24.12. oder 24.12.2000', type: OptionType.String, required: true }],
          run: async (ctx) => {
            const b = parseBirthday(ctx.arg<string>('datum'));
            if (!b) throw new UserError(ctx.t('badDate'));
            cog.config.user(ctx.author.id).set('birthday', b);
            await ctx.reply(ctx.t('saved', { date: fmt(b) }));
          },
        },
        {
          name: 'remove',
          description: 'Deinen Geburtstag löschen.',
          aliases: ['delete', 'löschen'],
          run: async (ctx) => {
            cog.config.user(ctx.author.id).clear();
            await ctx.reply(ctx.t('removed'));
          },
        },
        {
          name: 'show',
          description: 'Geburtstag anzeigen.',
          options: [{ name: 'user', description: 'Mitglied (Standard: du)', type: OptionType.User }],
          run: async (ctx) => {
            const user = ctx.arg<ResolvedUser | undefined>('user') ?? { id: ctx.author.id };
            const b = birthdayOf(user.id);
            if (!b) return ctx.reply(ctx.t('none', { user: `<@${user.id}>` }));
            const days = daysUntil(b, new Date());
            // Jahr nur der Person selbst zeigen
            const shown = user.id === ctx.author.id ? fmt(b) : fmt({ ...b, year: null });
            await ctx.reply(ctx.t(days === 0 ? 'showToday' : 'show', { user: `<@${user.id}>`, date: shown, days }));
          },
        },
        {
          name: 'list',
          description: 'Die nächsten Geburtstage auf diesem Server.',
          guildOnly: true,
          run: async (ctx) => {
            const now = new Date();
            const list = membersWithBirthdays(ctx.guildId!)
              .map((x) => ({ ...x, days: daysUntil(x.b, now) }))
              .sort((a, b) => a.days - b.days)
              .slice(0, 20);
            if (!list.length) return ctx.reply(ctx.t('emptyList'));
            const lines = list.map((x) => `${x.days === 0 ? '🎂' : '📅'} <@${x.userId}> – ${fmt({ ...x.b, year: null })} (${x.days === 0 ? ctx.t('today') : ctx.t('inDays', { count: x.days })})`);
            await ctx.sendEmbed(embed({ title: ctx.t('listTitle'), description: lines.join('\n'), color: 0xff69b4 }));
          },
        },
      ],
    });

    const admin = { level: 'admin', member: ['ManageGuild'] } as const;
    cog.group({
      name: 'bdset',
      description: 'Geburtstage einrichten.',
      guildOnly: true,
      permissions: admin,
      subcommands: [
        {
          name: 'channel',
          description: 'Kanal für Glückwünsche.',
          options: [{ name: 'kanal', description: 'Kanal', type: OptionType.Channel, required: true, channel_types: [0, 5] }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('channel', ctx.arg<{ id: string }>('kanal').id);
            await ctx.tick();
          },
        },
        {
          name: 'role',
          description: 'Geburtstagsrolle für 24 Stunden (leer = keine).',
          permissions: { level: 'admin', member: ['ManageGuild'], bot: ['ManageRoles'] },
          options: [{ name: 'rolle', description: 'Rolle', type: OptionType.Role }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('role', ctx.arg<APIRole | undefined>('rolle')?.id ?? null);
            await ctx.tick();
          },
        },
        {
          name: 'time',
          description: 'Uhrzeit der Glückwünsche (HH:MM).',
          options: [{ name: 'uhrzeit', description: 'z. B. 09:00', type: OptionType.String, required: true }],
          run: async (ctx: CommandContext) => {
            const m = /^(\d{1,2}):(\d{2})$/.exec(ctx.arg<string>('uhrzeit'));
            if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new UserError(ctx.t('badTime'));
            cog.config.guild(ctx.guildId!).set('time', `${m[1]!.padStart(2, '0')}:${m[2]}`);
            await ctx.tick();
          },
        },
        {
          name: 'message',
          description: 'Glückwunschtext ({user}, {age}, {server}).',
          options: [{ name: 'text', description: 'Text', type: OptionType.String, required: true, rest: true, max_length: 1000 }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('message', ctx.arg<string>('text'));
            await ctx.tick();
          },
        },
        {
          name: 'reminder',
          description: 'Am Vortag auf morgige Geburtstage hinweisen.',
          options: [{ name: 'aktiv', description: 'an/aus', type: OptionType.Boolean, required: true }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('reminder', ctx.arg<boolean>('aktiv'));
            await ctx.tick();
          },
        },
        {
          name: 'toggle',
          description: 'Geburtstage an/aus.',
          options: [{ name: 'aktiv', description: 'an/aus', type: OptionType.Boolean, required: true }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('enabled', ctx.arg<boolean>('aktiv'));
            await ctx.tick();
          },
        },
        {
          name: 'test',
          description: 'Heutige Glückwünsche sofort auslösen.',
          run: async (ctx) => {
            const n = await celebrate(ctx.guildId!, new Date());
            await ctx.reply(ctx.t('tested', { count: n }));
          },
        },
      ],
    });
  },
});
