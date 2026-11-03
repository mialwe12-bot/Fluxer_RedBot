import {
  defineCog,
  embed,
  formatDateTime,
  OptionType,
  parseDuration,
  relativeTime,
  sameEmoji,
  UserError,
  type APIEmbed,
  type APIRole,
  type Cog,
  type CommandContext,
  type ReactionEvent,
} from '@bot/sdk';

const WEEKDAYS = ['sonntag', 'montag', 'dienstag', 'mittwoch', 'donnerstag', 'freitag', 'samstag'];

/**
 * Zeitangabe → Zeitpunkt (lokale Zeit, Bot-Zeitzone). Unterstützt:
 * "in 2h", "heute 20:00", "morgen 19:30", "übermorgen 18 Uhr", "Samstag 20:00",
 * "24.12. 18:00", "24.12.2026 18:00", "2026-12-24 18:00", "20:00" (heute bzw. morgen).
 */
export function parseWhen(input: string, now: Date = new Date()): Date | undefined {
  const t = input.trim().toLowerCase().replace(/\s+uhr$/, '').replace(/\s+/g, ' ');
  const rel = /^in (.+)$/.exec(t);
  if (rel) {
    const s = parseDuration(rel[1]!, 'm');
    return s ? new Date(now.getTime() + s * 1000) : undefined;
  }
  const time = (s: string | undefined): [number, number] | undefined => {
    if (!s) return [20, 0];
    const m = /^(\d{1,2})(?:[:.](\d{2}))?(?: uhr)?$/.exec(s.trim());
    if (!m) return undefined;
    const h = Number(m[1]);
    const min = Number(m[2] ?? 0);
    return h < 24 && min < 60 ? [h, min] : undefined;
  };
  const at = (d: Date, hm: [number, number]) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), hm[0], hm[1], 0, 0);
  const day = /^(heute|morgen|übermorgen|uebermorgen)(?: (.+))?$/.exec(t);
  if (day) {
    const hm = time(day[2]);
    if (!hm) return undefined;
    const offset = day[1] === 'heute' ? 0 : day[1] === 'morgen' ? 1 : 2;
    return at(new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset), hm);
  }
  const wd = new RegExp(`^(${WEEKDAYS.join('|')})(?: (.+))?$`).exec(t);
  if (wd) {
    const hm = time(wd[2]);
    if (!hm) return undefined;
    const target = WEEKDAYS.indexOf(wd[1]!);
    let diff = (target - now.getDay() + 7) % 7;
    const candidate = at(new Date(now.getFullYear(), now.getMonth(), now.getDate() + diff), hm);
    if (candidate <= now) diff += 7;
    return at(new Date(now.getFullYear(), now.getMonth(), now.getDate() + diff), hm);
  }
  const de = /^(\d{1,2})\.(\d{1,2})\.(\d{2,4})?(?: (.+))?$/.exec(t);
  if (de) {
    const hm = time(de[4]);
    if (!hm) return undefined;
    let year = de[3] ? Number(de[3]) : now.getFullYear();
    if (year < 100) year += 2000;
    let d = new Date(year, Number(de[2]) - 1, Number(de[1]), hm[0], hm[1]);
    if (!de[3] && d < now) d = new Date(year + 1, Number(de[2]) - 1, Number(de[1]), hm[0], hm[1]);
    return d.getMonth() === Number(de[2]) - 1 ? d : undefined;
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[ t](.+))?$/.exec(t);
  if (iso) {
    const hm = time(iso[4]);
    return hm ? new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), hm[0], hm[1]) : undefined;
  }
  const onlyTime = time(t);
  if (onlyTime && /\d/.test(t)) {
    const today = at(now, onlyTime);
    return today > now ? today : at(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1), onlyTime);
  }
  return undefined;
}

interface EventData {
  id: number;
  title: string;
  description: string;
  start: number;
  host: string;
  channelId: string;
  messageId: string;
  participants: string[];
  maybe: string[];
  max: number;
  reminded: boolean;
  ended: boolean;
  cancelled: boolean;
}

export default defineCog({
  setup(cog: Cog) {
    cog.config.registerGuild({
      channel: null as string | null,
      pingRole: null as string | null,
      max: 0,
      reminderMinutes: 15,
      creators: 'everyone' as 'everyone' | 'mod',
      counter: 0,
      events: {} as Record<string, EventData>,
    });
    const p = () => cog.platform;
    const JOIN = '✅';
    const MAYBE = '❔';

    const render = (g: string, e: EventData): APIEmbed => {
      const status = e.cancelled ? cog.tg(g, 'cancelledTag') : e.ended ? cog.tg(g, 'endedTag') : '';
      const list = (ids: string[]) => ids.slice(0, 40).map((u) => `<@${u}>`).join(', ') + (ids.length > 40 ? ` +${ids.length - 40}` : '');
      return embed({
        title: `📅 ${e.title}${status ? ` ${status}` : ''}`,
        description: e.description || undefined,
        fields: [
          { name: cog.tg(g, 'when'), value: `${formatDateTime(e.start)} (${relativeTime(e.start)})`, inline: true },
          { name: cog.tg(g, 'host'), value: `<@${e.host}>`, inline: true },
          { name: `${JOIN} ${cog.tg(g, 'going')} (${e.participants.length}${e.max ? `/${e.max}` : ''})`, value: list(e.participants) || '–' },
          { name: `${MAYBE} ${cog.tg(g, 'maybe')} (${e.maybe.length})`, value: list(e.maybe) || '–' },
        ],
        footer: cog.tg(g, 'footer', { id: e.id }),
        color: e.cancelled ? 0x95a5a6 : e.ended ? 0x7f8c8d : 0x1abc9c,
      });
    };

    const save = (g: string, e: EventData) => cog.config.guild(g).update<Record<string, EventData>>('events', (all) => ({ ...all, [String(e.id)]: e }));
    const refresh = async (g: string, e: EventData) => {
      await p().editMessage(e.channelId, e.messageId, await cog.bot.adaptPayload({ embeds: [render(g, e)] }, g, e.channelId)).catch(() => undefined);
    };
    const byMessage = (g: string, messageId: string) => Object.values(cog.config.guild(g).get<Record<string, EventData>>('events')).find((e) => e.messageId === messageId);

    // ------------------------------------------------------------------ Anmeldung per Reaktion
    cog.on('MESSAGE_REACTION_ADD', async (r: ReactionEvent) => {
      if (!r.guild_id || r.user_id === p().user?.id) return;
      const e = byMessage(r.guild_id, r.message_id);
      if (!e || e.ended || e.cancelled) return;
      const isJoin = sameEmoji(JOIN, r.emoji);
      if (!isJoin && !sameEmoji(MAYBE, r.emoji)) return;
      if (isJoin && e.max && e.participants.length >= e.max && !e.participants.includes(r.user_id)) {
        await p().removeReaction(r.channel_id, r.message_id, JOIN, r.user_id).catch(() => undefined);
        await p().sendDM(r.user_id, cog.tg(r.guild_id, 'full', { title: e.title })).catch(() => undefined);
        return;
      }
      const next = {
        ...e,
        participants: isJoin ? [...new Set([...e.participants, r.user_id])] : e.participants.filter((u) => u !== r.user_id),
        maybe: isJoin ? e.maybe.filter((u) => u !== r.user_id) : [...new Set([...e.maybe, r.user_id])],
      };
      save(r.guild_id, next);
      await refresh(r.guild_id, next);
    });

    cog.on('MESSAGE_REACTION_REMOVE', async (r: ReactionEvent) => {
      if (!r.guild_id) return;
      const e = byMessage(r.guild_id, r.message_id);
      if (!e || e.ended || e.cancelled) return;
      const key = sameEmoji(JOIN, r.emoji) ? 'participants' : sameEmoji(MAYBE, r.emoji) ? 'maybe' : null;
      if (!key) return;
      const next = { ...e, [key]: e[key].filter((u) => u !== r.user_id) };
      save(r.guild_id, next);
      await refresh(r.guild_id, next);
    });

    // ------------------------------------------------------------------ Erinnerungen und Abschluss
    cog.schedule({
      name: 'event-erinnerungen',
      every: 60,
      run: async () => {
        const now = Date.now();
        for (const [guildId, data] of Object.entries(cog.config.allGuilds<{ events: Record<string, EventData>; reminderMinutes: number }>())) {
          for (const e of Object.values(data.events ?? {})) {
            if (e.cancelled || e.ended) continue;
            if (!e.reminded && e.start - now <= data.reminderMinutes * 60_000 && e.start > now - 60_000) {
              const mentions = e.participants.slice(0, 50);
              await cog.bot
                .send(e.channelId, {
                  content: cog.tg(guildId, 'reminder', { title: e.title, time: relativeTime(e.start), users: mentions.map((u) => `<@${u}>`).join(' ') }),
                  allowed_mentions: { users: mentions },
                  message_reference: { message_id: e.messageId, channel_id: e.channelId, fail_if_not_exists: false },
                })
                .catch(() => undefined);
              save(guildId, { ...e, reminded: true });
            }
            if (now > e.start + 6 * 3600_000) {
              const ended = { ...e, ended: true };
              save(guildId, ended);
              await refresh(guildId, ended);
            }
          }
          // Abgeschlossene Events nach 30 Tagen vergessen
          cog.config.guild(guildId).update<Record<string, EventData>>('events', (all) =>
            Object.fromEntries(Object.entries(all).filter(([, e]) => !(e.ended || e.cancelled) || now - e.start < 30 * 86400_000)),
          );
        }
      },
    });

    // ------------------------------------------------------------------ Befehle
    const canManage = async (ctx: CommandContext, e: EventData) =>
      e.host === ctx.author.id || ['mod', 'admin', 'guildowner', 'owner'].includes(await ctx.bot.levelOf(ctx.guildId, ctx.author.id));
    const getEvent = (ctx: CommandContext, id: number): EventData => {
      const e = cog.config.guild(ctx.guildId!).get<Record<string, EventData>>('events')[String(id)];
      if (!e) throw new UserError(ctx.t('notFound', { id }));
      return e;
    };

    cog.group({
      name: 'event',
      description: 'Events planen.',
      guildOnly: true,
      subcommands: [
        {
          name: 'create',
          description: 'Neues Event: <wann> | <Titel> [| Beschreibung]',
          aliases: ['new', 'neu'],
          options: [{ name: 'angaben', description: 'Wann | Titel | Beschreibung', type: OptionType.String, required: true, rest: true }],
          examples: ['event create Samstag 20:00 | Spieleabend | Wir spielen Among Us', 'event create 24.12. 18:00 | Weihnachtsfeier', 'event create in 2h | Raid'],
          run: async (ctx) => {
            const conf = cog.config.guild(ctx.guildId!);
            if (conf.get<string>('creators') === 'mod' && !['mod', 'admin', 'guildowner', 'owner'].includes(await ctx.bot.levelOf(ctx.guildId, ctx.author.id))) {
              throw new UserError(ctx.t('modsOnly'));
            }
            const [when, title, ...desc] = ctx.arg<string>('angaben').split('|').map((x) => x.trim());
            if (!when || !title) throw new UserError(ctx.t('usage'));
            const start = parseWhen(when);
            if (!start) throw new UserError(ctx.t('badTime'));
            if (start.getTime() < Date.now()) throw new UserError(ctx.t('inPast'));
            const channel = conf.get<string | null>('channel') ?? ctx.channelId;
            const id = conf.update<number>('counter', (n) => (n ?? 0) + 1);
            const e: EventData = {
              id,
              title: title.slice(0, 200),
              description: desc.join(' | ').slice(0, 2000),
              start: start.getTime(),
              host: ctx.author.id,
              channelId: channel,
              messageId: '',
              participants: [ctx.author.id],
              maybe: [],
              max: conf.get<number>('max'),
              reminded: false,
              ended: false,
              cancelled: false,
            };
            const role = conf.get<string | null>('pingRole');
            const msg = await ctx.bot.send(
              channel,
              { ...(await ctx.bot.adaptPayload({ embeds: [render(ctx.guildId!, e)] }, ctx.guildId, channel)), ...(role ? { content: `<@&${role}>`, allowed_mentions: { roles: [role] } } : {}) },
              ctx.guildId,
            );
            e.messageId = msg.id;
            save(ctx.guildId!, e);
            for (const em of [JOIN, MAYBE]) await p().addReaction(channel, msg.id, em).catch(() => undefined);
            if (channel !== ctx.channelId) await ctx.reply(ctx.t('created', { id, channel: `<#${channel}>` }));
          },
        },
        {
          name: 'list',
          description: 'Kommende Events.',
          run: async (ctx) => {
            const list = Object.values(cog.config.guild(ctx.guildId!).get<Record<string, EventData>>('events'))
              .filter((e) => !e.ended && !e.cancelled)
              .sort((a, b) => a.start - b.start);
            if (!list.length) return ctx.reply(ctx.t('none'));
            await ctx.sendEmbed({
              title: ctx.t('listTitle'),
              description: list.map((e) => `**#${e.id} ${e.title}** – ${formatDateTime(e.start)} (${relativeTime(e.start)}) – ${e.participants.length} ${ctx.t('going')}`).join('\n').slice(0, 4000),
            });
          },
        },
        {
          name: 'cancel',
          description: 'Event absagen (Veranstalter oder Mods).',
          options: [{ name: 'id', description: 'Event-Nummer', type: OptionType.Integer, required: true }],
          run: async (ctx) => {
            const e = getEvent(ctx, ctx.arg<number>('id'));
            if (!(await canManage(ctx, e))) throw new UserError(ctx.t('notHost'));
            const next = { ...e, cancelled: true };
            save(ctx.guildId!, next);
            await refresh(ctx.guildId!, next);
            const mentions = e.participants.filter((u) => u !== ctx.author.id).slice(0, 50);
            await ctx.send({ content: ctx.t('cancelled', { title: e.title, users: mentions.map((u) => `<@${u}>`).join(' ') }), allowed_mentions: { users: mentions } });
          },
        },
        {
          name: 'edit',
          description: 'Zeit oder Titel ändern: <id> <wann> | <Titel> [| Beschreibung]',
          options: [
            { name: 'id', description: 'Event-Nummer', type: OptionType.Integer, required: true },
            { name: 'angaben', description: 'Wann | Titel | Beschreibung', type: OptionType.String, required: true, rest: true },
          ],
          run: async (ctx) => {
            const e = getEvent(ctx, ctx.arg<number>('id'));
            if (!(await canManage(ctx, e))) throw new UserError(ctx.t('notHost'));
            const [when, title, ...desc] = ctx.arg<string>('angaben').split('|').map((x) => x.trim());
            const start = when ? parseWhen(when) : undefined;
            if (when && !start) throw new UserError(ctx.t('badTime'));
            const next = { ...e, start: start?.getTime() ?? e.start, title: title || e.title, description: desc.length ? desc.join(' | ') : e.description, reminded: start ? false : e.reminded };
            save(ctx.guildId!, next);
            await refresh(ctx.guildId!, next);
            await ctx.tick();
          },
        },
      ],
    });

    cog.group({
      name: 'eventset',
      description: 'Events einrichten.',
      guildOnly: true,
      permissions: { level: 'admin', member: ['ManageGuild'] },
      subcommands: [
        {
          name: 'channel',
          description: 'Kanal für Event-Posts (leer = dort, wo der Befehl kommt).',
          options: [{ name: 'kanal', description: 'Kanal', type: OptionType.Channel, channel_types: [0, 5] }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('channel', ctx.arg<{ id: string } | undefined>('kanal')?.id ?? null);
            await ctx.tick();
          },
        },
        {
          name: 'pingrole',
          description: 'Rolle, die bei neuen Events erwähnt wird (leer = keine).',
          options: [{ name: 'rolle', description: 'Rolle', type: OptionType.Role }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('pingRole', ctx.arg<APIRole | undefined>('rolle')?.id ?? null);
            await ctx.tick();
          },
        },
        {
          name: 'max',
          description: 'Standard-Teilnehmerlimit (0 = unbegrenzt).',
          options: [{ name: 'anzahl', description: 'Anzahl', type: OptionType.Integer, required: true, min_value: 0, max_value: 1000 }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('max', ctx.arg<number>('anzahl'));
            await ctx.tick();
          },
        },
        {
          name: 'reminder',
          description: 'Minuten vor dem Start erinnern.',
          options: [{ name: 'minuten', description: 'Minuten', type: OptionType.Integer, required: true, min_value: 1, max_value: 1440 }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('reminderMinutes', ctx.arg<number>('minuten'));
            await ctx.tick();
          },
        },
        {
          name: 'creators',
          description: 'Wer Events anlegen darf.',
          options: [
            {
              name: 'wer',
              description: 'alle oder mods',
              type: OptionType.String,
              required: true,
              choices: [
                { name: 'alle', value: 'everyone' },
                { name: 'mods', value: 'mod' },
              ],
            },
          ],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('creators', ctx.arg<string>('wer'));
            await ctx.tick();
          },
        },
      ],
    });
  },
});
