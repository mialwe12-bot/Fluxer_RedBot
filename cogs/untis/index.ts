import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { WebUntis, type Lesson } from 'webuntis';
import { defineCog, OptionType, UserError, type APIMessage, type Cog, type CommandContext } from '@bot/sdk';

// ---------------------------------------------------------------------- Verschlüsselung

/** Schlüssel aus UNTIS_ENCRYPTION_KEY: 64 Hex-Zeichen oder Base64 von 32 Bytes. */
export function parseKey(raw: string | undefined): Buffer | null {
  if (!raw) return null;
  const t = raw.trim();
  if (/^[0-9a-f]{64}$/i.test(t)) return Buffer.from(t, 'hex');
  try {
    const b = Buffer.from(t, 'base64');
    return b.length === 32 ? b : null;
  } catch {
    return null;
  }
}

/** AES-256-GCM: "iv.tag.daten" (Base64). */
export function encrypt(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}

export function decrypt(blob: string, key: Buffer): string {
  const [iv, tag, data] = blob.split('.').map((s) => Buffer.from(s, 'base64')) as [Buffer, Buffer, Buffer];
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

// ---------------------------------------------------------------------- Stundenplan-Logik

export interface Snap {
  id: number;
  date: number;
  start: number;
  end: number;
  subject: string;
  teachers: string[];
  rooms: string[];
  origTeachers: string[];
  origRooms: string[];
  code: string | null;
  text: string | null;
}

export type ChangeType = 'cancelled' | 'substitution' | 'teacher' | 'room' | 'time';

export interface Change {
  lesson: Snap;
  type: ChangeType;
  /** Eindeutiger Schlüssel gegen Wiederholungen. */
  key: string;
  detail: Record<string, string>;
}

type Short = { name?: string; longname?: string; orgname?: string };
const names = (list: Short[] | undefined) => (list ?? []).map((x) => x.name ?? x.longname ?? '').filter(Boolean);
const orgNames = (list: Short[] | undefined) => (list ?? []).map((x) => x.orgname ?? '').filter(Boolean);

export function toSnap(l: Lesson): Snap {
  const su = (l.su ?? []) as Short[];
  return {
    id: l.id,
    date: l.date,
    start: l.startTime,
    end: l.endTime,
    subject: su[0]?.longname || su[0]?.name || l.lstext || 'Stunde',
    teachers: names(l.te as Short[]),
    rooms: names(l.ro as Short[]),
    origTeachers: orgNames(l.te as Short[]),
    origRooms: orgNames(l.ro as Short[]),
    code: l.code ?? null,
    text: l.substText || l.info || null,
  };
}

/**
 * Änderungen erkennen: Entfall (code cancelled), Vertretung/Sonderstunde (code irregular oder Vertretungstext),
 * Lehrer- und Raumwechsel (WebUntis liefert den ursprünglichen Wert als "orgname" oder Vergleich mit dem
 * letzten Stand) sowie geänderte Zeiten (Vergleich mit dem letzten Stand).
 */
export function detectChanges(prev: Record<string, Snap> | null, cur: Snap[]): Change[] {
  const out: Change[] = [];
  const push = (lesson: Snap, type: ChangeType, value: string, detail: Record<string, string> = {}) =>
    out.push({ lesson, type, key: `${lesson.id}:${type}:${value}`, detail });
  for (const l of cur) {
    const before = prev?.[String(l.id)];
    if (l.code === 'cancelled') {
      push(l, 'cancelled', String(l.date));
      continue;
    }
    if (l.code === 'irregular' || l.text) push(l, 'substitution', `${l.teachers.join(',')}|${l.text ?? ''}`, { text: l.text ?? '' });
    const teacherChanged = l.origTeachers.length > 0 || (before && before.teachers.join(',') !== l.teachers.join(','));
    if (teacherChanged && l.teachers.length) {
      push(l, 'teacher', l.teachers.join(','), { from: (l.origTeachers.length ? l.origTeachers : (before?.teachers ?? [])).join(', ') || '?', to: l.teachers.join(', ') });
    }
    const roomChanged = l.origRooms.length > 0 || (before && before.rooms.join(',') !== l.rooms.join(','));
    if (roomChanged && l.rooms.length) {
      push(l, 'room', l.rooms.join(','), { from: (l.origRooms.length ? l.origRooms : (before?.rooms ?? [])).join(', ') || '?', to: l.rooms.join(', ') });
    }
    if (before && (before.start !== l.start || before.end !== l.end || before.date !== l.date)) {
      push(l, 'time', `${l.date}-${l.start}-${l.end}`, { from: `${fmtTime(before.start)}–${fmtTime(before.end)}`, to: `${fmtTime(l.start)}–${fmtTime(l.end)}` });
    }
  }
  return out;
}

export const fmtTime = (hhmm: number) => `${String(Math.floor(hhmm / 100)).padStart(2, '0')}:${String(hhmm % 100).padStart(2, '0')}`;
export const toDate = (yyyymmdd: number) => new Date(Math.floor(yyyymmdd / 10000), Math.floor((yyyymmdd % 10000) / 100) - 1, yyyymmdd % 100);
const dateNum = (d: Date) => d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
const fmtDay = (n: number) => toDate(n).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });

// ---------------------------------------------------------------------- Cog

interface Account {
  server: string;
  school: string;
  username: string;
  password: string; // verschlüsselt
  notify: 'dm' | 'channel' | 'off';
  guildId: string | null;
  channelId: string | null;
  failures: number;
}

export default defineCog({
  setup(cog: Cog) {
    cog.config.registerUser({
      account: null as Account | null,
      snapshot: null as Record<string, Snap> | null,
      reported: [] as string[],
    });
    cog.config.registerGlobal({ interval: 15, lastRun: 0 });
    const key = parseKey(process.env.UNTIS_ENCRYPTION_KEY);
    const p = () => cog.platform;
    const requireKey = (ctx?: CommandContext): Buffer => {
      if (!key) throw new UserError(ctx ? ctx.t('noKey') : cog.t('noKey'));
      return key;
    };

    const normalizeServer = (s: string) => s.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');

    async function withSession<T>(acc: Account, fn: (u: WebUntis) => Promise<T>): Promise<T> {
      const untis = new WebUntis(acc.school, acc.username, decrypt(acc.password, requireKey()), acc.server);
      await untis.login();
      try {
        return await fn(untis);
      } finally {
        await untis.logout().catch(() => undefined);
      }
    }

    async function fetchRange(acc: Account, from: Date, to: Date): Promise<Snap[]> {
      return withSession(acc, async (u) => {
        let lessons: Lesson[];
        try {
          lessons = await u.getOwnTimetableForRange(from, to);
        } catch {
          // Manche Konten (z. B. Eltern/Lehrkräfte) haben keinen eigenen Plan → Klassenplan
          lessons = await u.getOwnClassTimetableForRange(from, to);
        }
        return lessons.map(toSnap).sort((a, b) => a.date - b.date || a.start - b.start);
      });
    }

    const loginErrorText = (err: unknown): string => {
      const m = ((err as Error)?.message ?? '').toLowerCase();
      if (m.includes('bad credentials') || m.includes('invalid') || m.includes('failed to login') || m.includes('authentication')) return cog.t('badCredentials');
      if (m.includes('enotfound') || m.includes('getaddrinfo')) return cog.t('badServer');
      return cog.t('loginFailed', { reason: (err as Error)?.message?.slice(0, 200) ?? '?' });
    };

    const lessonLine = (l: Snap): string => {
      const status = l.code === 'cancelled' ? ' ❌' : l.code === 'irregular' ? ' 🔁' : l.origRooms.length || l.origTeachers.length ? ' ⚠️' : '';
      const extras = [l.teachers.join(', '), l.rooms.join(', ')].filter(Boolean).join(' · ');
      const struck = l.code === 'cancelled' ? `~~${l.subject}~~` : `**${l.subject}**`;
      return `\`${fmtTime(l.start)}–${fmtTime(l.end)}\` ${struck}${extras ? ` (${extras})` : ''}${status}${l.text ? `\n  ↳ ${l.text}` : ''}`;
    };
    const renderDays = (lessons: Snap[], title: string): string => {
      if (!lessons.length) return `**${title}**\n${cog.t('free')}`;
      const byDay = new Map<number, Snap[]>();
      for (const l of lessons) byDay.set(l.date, [...(byDay.get(l.date) ?? []), l]);
      return [`**${title}**`, ...[...byDay.entries()].map(([d, ls]) => `\n__${fmtDay(d)}__\n${ls.map(lessonLine).join('\n')}`)].join('\n');
    };

    const changeLine = (c: Change): string => {
      const head = `**${fmtDay(c.lesson.date)} ${fmtTime(c.lesson.start)} ${c.lesson.subject}**`;
      return `${head}: ${cog.t(`changes.${c.type}`, c.detail)}`;
    };

    /** Prüft einen Benutzer: neue Änderungen melden, Stand speichern. */
    async function checkUser(userId: string): Promise<number> {
      const conf = cog.config.user(userId);
      const acc = conf.get<Account | null>('account');
      if (!acc || acc.notify === 'off') return 0;
      const today = new Date();
      let lessons: Snap[];
      try {
        lessons = await fetchRange(acc, today, new Date(today.getFullYear(), today.getMonth(), today.getDate() + 6));
      } catch (err) {
        const failures = acc.failures + 1;
        conf.set('account', { ...acc, failures, notify: failures >= 3 ? 'off' : acc.notify });
        if (failures === 3) await p().sendDM(userId, cog.t('disabledAfterFailures', { reason: loginErrorText(err) })).catch(() => undefined);
        cog.log.warn({ userId, failures, err: (err as Error).message }, 'WebUntis-Abruf fehlgeschlagen');
        return 0;
      }
      const nowNum = dateNum(today);
      const nowTime = today.getHours() * 100 + today.getMinutes();
      const upcoming = lessons.filter((l) => l.date > nowNum || (l.date === nowNum && l.end >= nowTime));
      const prev = conf.get<Record<string, Snap> | null>('snapshot');
      const reported = new Set(conf.get<string[]>('reported'));
      const fresh = detectChanges(prev, upcoming).filter((c) => !reported.has(c.key));
      conf.setAll({
        snapshot: Object.fromEntries(lessons.map((l) => [String(l.id), l])),
        reported: [...reported, ...fresh.map((c) => c.key)].slice(-400),
        account: { ...acc, failures: 0 },
      });
      if (!fresh.length) return 0;
      const text = `📅 ${cog.t('changesTitle')}\n${fresh.map(changeLine).join('\n')}`.slice(0, 1990);
      if (acc.notify === 'channel' && acc.channelId) {
        await cog.bot.send(acc.channelId, { content: `<@${userId}> ${text}`, allowed_mentions: { users: [userId] } }, acc.guildId ?? undefined).catch(() => p().sendDM(userId, text));
      } else {
        await p().sendDM(userId, text).catch(() => undefined);
      }
      return fresh.length;
    }

    cog.schedule({
      name: 'stundenplan-check',
      every: 60,
      run: async () => {
        if (!key) return;
        const g = cog.config.global();
        if (Date.now() - g.get<number>('lastRun') < g.get<number>('interval') * 60_000) return;
        g.set('lastRun', Date.now());
        for (const [userId, data] of Object.entries(cog.config.allUsers<{ account: Account | null }>())) {
          if (!data.account || data.account.notify === 'off') continue;
          await checkUser(userId);
          await new Promise((r) => setTimeout(r, 2000)); // WebUntis schonen
        }
      },
    });

    /** Zugangsdaten im Server-Kanal → sofort löschen und warnen. */
    async function warnPublic(m: Pick<APIMessage, 'id' | 'channel_id' | 'author'>, guildId: string): Promise<void> {
      await p().deleteMessage(m.channel_id, m.id, 'Zugangsdaten geschützt').catch(() => undefined);
      await cog.bot
        .send(m.channel_id, { content: cog.tg(guildId, 'publicWarning', { user: `<@${m.author.id}>` }), allowed_mentions: { users: [m.author.id] } }, guildId)
        .catch(() => undefined);
      await p().sendDM(m.author.id, cog.tg(guildId, 'publicWarningDm')).catch(() => undefined);
    }
    // Jede "untis login …"-Nachricht in einem Server (mit oder ohne gültiges Prefix, auch bei
    // fehlerhaften Argumenten) wird gelöscht. Der Befehl selbst tut in Servern deshalb nichts.
    cog.on('MESSAGE_CREATE', async (m: APIMessage) => {
      if (!m.guild_id || !m.author || (m.author as { bot?: boolean }).bot) return;
      const content = m.content ?? '';
      if (!/^\S{0,3}\s*(?:untis|stundenplan)\s+login\b/i.test(content) && !/^<@!?\d+>\s*(?:untis|stundenplan)\s+login\b/i.test(content)) return;
      await warnPublic(m, m.guild_id);
    });

    const requireAccount = (ctx: CommandContext): Account => {
      const acc = cog.config.user(ctx.author.id).get<Account | null>('account');
      if (!acc) throw new UserError(ctx.t('notLoggedIn', { prefix: ctx.prefix }));
      requireKey(ctx);
      return acc;
    };

    const show = async (ctx: CommandContext, offset: number, days: number, titleKey: string) => {
      const acc = requireAccount(ctx);
      await ctx.typing();
      const start = new Date();
      start.setDate(start.getDate() + offset);
      const end = new Date(start);
      end.setDate(end.getDate() + days - 1);
      let lessons: Snap[];
      try {
        lessons = await fetchRange(acc, start, end);
      } catch (err) {
        throw new UserError(loginErrorText(err));
      }
      const text = renderDays(lessons, ctx.t(titleKey));
      // Stundenplan ist persönlich → in Servern nur per DM
      if (ctx.guildId) {
        for (const chunk of text.match(/[\s\S]{1,1900}(?=\n|$)/g) ?? [text]) await ctx.dm(chunk);
        await ctx.reply(ctx.t('sentDm'));
      } else {
        for (const chunk of text.match(/[\s\S]{1,1900}(?=\n|$)/g) ?? [text]) await ctx.send(chunk);
      }
    };

    cog.group({
      name: 'untis',
      description: 'WebUntis-Stundenplan.',
      aliases: ['stundenplan'],
      subcommands: [
        {
          name: 'login',
          description: 'Zugangsdaten hinterlegen – NUR per DM an den Bot!',
          options: [
            { name: 'server', description: 'WebUntis-Server, z. B. neilo.webuntis.com', type: OptionType.String, required: true },
            { name: 'schule', description: 'Schulname wie in WebUntis (Anführungszeichen bei Leerzeichen)', type: OptionType.String, required: true },
            { name: 'benutzer', description: 'Benutzername', type: OptionType.String, required: true },
            { name: 'passwort', description: 'Passwort', type: OptionType.String, required: true, rest: true },
          ],
          examples: ['untis login neilo.webuntis.com "Gymnasium Musterstadt" max.mustermann geheim123'],
          run: async (ctx) => {
            if (ctx.guildId) return; // Nachricht wurde bereits gelöscht und gewarnt (Listener oben)
            const k = requireKey(ctx);
            const acc: Account = {
              server: normalizeServer(ctx.arg<string>('server')),
              school: ctx.arg<string>('schule'),
              username: ctx.arg<string>('benutzer'),
              password: encrypt(ctx.arg<string>('passwort'), k),
              notify: 'dm',
              guildId: null,
              channelId: null,
              failures: 0,
            };
            await ctx.typing();
            try {
              await withSession(acc, async () => undefined);
            } catch (err) {
              throw new UserError(loginErrorText(err));
            }
            cog.config.user(ctx.author.id).setAll({ account: acc, snapshot: null, reported: [] });
            await ctx.reply(ctx.t('loggedIn', { prefix: ctx.prefix }));
          },
        },
        { name: 'heute', description: 'Stundenplan für heute.', aliases: ['today'], run: (ctx) => show(ctx, 0, 1, 'today') },
        { name: 'morgen', description: 'Stundenplan für morgen.', aliases: ['tomorrow'], run: (ctx) => show(ctx, 1, 1, 'tomorrow') },
        { name: 'woche', description: 'Die nächsten 7 Tage.', aliases: ['week'], run: (ctx) => show(ctx, 0, 7, 'week') },
        {
          name: 'notify',
          description: 'Benachrichtigungen: dm, kanal (im Server ausführen) oder aus.',
          options: [
            {
              name: 'ziel',
              description: 'dm, kanal oder aus',
              type: OptionType.String,
              required: true,
              choices: [
                { name: 'dm', value: 'dm' },
                { name: 'kanal', value: 'channel' },
                { name: 'aus', value: 'off' },
              ],
            },
          ],
          run: async (ctx) => {
            const acc = requireAccount(ctx);
            const target = ctx.arg<'dm' | 'channel' | 'off'>('ziel');
            if (target === 'channel' && !ctx.guildId) throw new UserError(ctx.t('channelInGuild'));
            cog.config.user(ctx.author.id).set('account', {
              ...acc,
              notify: target,
              guildId: target === 'channel' ? ctx.guildId! : null,
              channelId: target === 'channel' ? ctx.channelId : null,
              failures: 0,
            });
            await ctx.reply(ctx.t(`notify.${target}`, { channel: `<#${ctx.channelId}>` }));
          },
        },
        {
          name: 'status',
          description: 'Zeigt, ob du angemeldet bist.',
          run: async (ctx) => {
            const acc = cog.config.user(ctx.author.id).get<Account | null>('account');
            await ctx.reply(acc ? ctx.t('status', { school: acc.school, server: acc.server, user: acc.username, notify: ctx.t(`notifyShort.${acc.notify}`) }) : ctx.t('notLoggedIn', { prefix: ctx.prefix }));
          },
        },
        {
          name: 'check',
          description: 'Jetzt auf Änderungen prüfen.',
          cooldown: { rate: 2, per: 300, bucket: 'user' },
          run: async (ctx) => {
            requireAccount(ctx);
            await ctx.typing();
            const n = await checkUser(ctx.author.id);
            await ctx.reply(n ? ctx.t('checkFound', { count: n }) : ctx.t('checkNone'));
          },
        },
        {
          name: 'forget',
          description: 'Abmelden und alle gespeicherten Daten löschen.',
          aliases: ['logout', 'abmelden'],
          run: async (ctx) => {
            cog.config.user(ctx.author.id).clear();
            await ctx.reply(ctx.t('forgotten'));
          },
        },
      ],
    });

    cog.group({
      name: 'untisset',
      description: 'WebUntis-Einstellungen (Owner).',
      permissions: { level: 'owner' },
      subcommands: [
        {
          name: 'interval',
          description: 'Prüfintervall in Minuten.',
          options: [{ name: 'minuten', description: 'Minuten (5–240)', type: OptionType.Integer, required: true, min_value: 5, max_value: 240 }],
          run: async (ctx) => {
            cog.config.global().set('interval', ctx.arg<number>('minuten'));
            await ctx.tick();
          },
        },
      ],
    });
  },
});
