import {
  defineCog,
  escapeRegex,
  humanizeSeconds,
  OptionType,
  pagify,
  takeDuration,
  UserError,
  type APIGuildMember,
  type APIMessage,
  type Cog,
  type CommandContext,
} from '@bot/sdk';
import type { ModlogApi } from '../modlog/index.js';

/** Begriff → RegExp. `*` ist Platzhalter, sonst ganze Wörter (Unicode-fähig, ohne Groß/Klein). */
export function termToPattern(term: string): string {
  const parts = term.trim().split('*').map(escapeRegex);
  const body = parts.join('[\\p{L}\\p{N}_]*');
  return `(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`;
}

export function buildMatcher(terms: string[]): RegExp | null {
  const clean = [...new Set(terms.map((t) => t.trim().toLowerCase()).filter(Boolean))];
  if (!clean.length) return null;
  return new RegExp(clean.map(termToPattern).join('|'), 'iu');
}

export default defineCog({
  setup(cog: Cog) {
    cog.config.registerGuild({
      words: [] as string[],
      filterNames: false,
      defaultName: 'Bürger',
      banCount: 0,
      banSeconds: 0,
    });
    cog.config.registerChannel({ words: [] as string[] });
    const p = () => cog.platform;
    const modlog = () => cog.bot.cogApi<ModlogApi>('modlog');

    // Cache der kompilierten Ausdrücke; wird bei Änderungen geleert.
    const cache = new Map<string, RegExp | null>();
    const matcher = (scope: 'guild' | 'channel', id: string): RegExp | null => {
      const key = `${scope}:${id}`;
      if (!cache.has(key)) {
        const words = (scope === 'guild' ? cog.config.guild(id) : cog.config.channel(id)).get<string[]>('words');
        cache.set(key, buildMatcher(words));
      }
      return cache.get(key)!;
    };
    const hits = new Map<string, number[]>();

    const isFiltered = (guildId: string, channelId: string, text: string): string | null => {
      if (!text) return null;
      for (const m of [matcher('guild', guildId), matcher('channel', channelId)]) {
        const found = m?.exec(text);
        if (found) return found[0];
      }
      return null;
    };

    async function handle(message: Pick<APIMessage, 'id' | 'channel_id' | 'guild_id' | 'author' | 'content'>): Promise<void> {
      const guildId = message.guild_id;
      if (!guildId || !message.author || (message.author as { bot?: boolean }).bot) return;
      const word = isFiltered(guildId, message.channel_id, message.content ?? '');
      if (!word) return;
      if (await cog.bot.isImmune(guildId, message.author.id)) return;
      try {
        await p().deleteMessage(message.channel_id, message.id, cog.tg(guildId, 'auditReason'));
      } catch (err) {
        cog.log.debug({ err }, 'Gefilterte Nachricht konnte nicht gelöscht werden');
        return;
      }
      await modlog()?.createCase({ guildId, action: 'filterhit', targetId: message.author.id, moderatorId: p().user?.id ?? null, reason: cog.tg(guildId, 'caseReason', { word }) });
      // Wiederholte Treffer → Bann
      const conf = cog.config.guild(guildId);
      const count = conf.get<number>('banCount');
      const window = conf.get<number>('banSeconds') * 1000;
      if (count > 0 && window > 0) {
        const key = `${guildId}:${message.author.id}`;
        const now = Date.now();
        const list = (hits.get(key) ?? []).filter((t) => now - t < window);
        list.push(now);
        hits.set(key, list);
        if (list.length >= count) {
          hits.delete(key);
          const reason = cog.tg(guildId, 'banReason', { count, time: humanizeSeconds(window / 1000) });
          await p().banMember(guildId, message.author.id, { reason }).catch((err) => cog.log.warn({ err }, 'Filter-Bann fehlgeschlagen'));
          await modlog()?.createCase({ guildId, action: 'ban', targetId: message.author.id, moderatorId: p().user?.id ?? null, reason });
        }
      }
    }

    async function checkName(guildId: string, member: APIGuildMember): Promise<void> {
      const conf = cog.config.guild(guildId);
      if (!conf.get<boolean>('filterNames') || !member?.user) return;
      const m = matcher('guild', guildId);
      if (!m) return;
      const shown = member.nick ?? member.user.username ?? '';
      if (!m.test(shown)) return;
      if (await cog.bot.isImmune(guildId, member.user.id)) return;
      await p()
        .editMember(guildId, member.user.id, { nick: conf.get<string>('defaultName') }, cog.tg(guildId, 'nameReason'))
        .catch((err) => cog.log.debug({ err }, 'Name konnte nicht gefiltert werden'));
    }

    cog.on('MESSAGE_CREATE', (m: APIMessage) => handle(m));
    cog.on('MESSAGE_UPDATE', (m: APIMessage) => {
      if (typeof m.content === 'string' && m.author) return handle(m);
    });
    cog.on('GUILD_MEMBER_ADD', (m: APIGuildMember & { guild_id: string }) => checkName(m.guild_id, m));
    cog.on('GUILD_MEMBER_UPDATE', (m: APIGuildMember & { guild_id: string }) => checkName(m.guild_id, m));

    // ------------------------------------------------------------------ Befehle
    const wordsOpt = { name: 'begriffe', description: 'Begriffe, Leerzeichen-getrennt ("mit Anführungszeichen" für Phrasen, * als Platzhalter)', type: OptionType.String, required: true, variadic: true } as const;

    const editWords = (ctx: CommandContext, scope: 'guild' | 'channel', add: boolean) => {
      const id = scope === 'guild' ? ctx.guildId! : ctx.channelId;
      const conf = scope === 'guild' ? cog.config.guild(id) : cog.config.channel(id);
      const terms = ctx.arg<string[]>('begriffe').map((w) => w.toLowerCase().trim()).filter(Boolean);
      for (const t of terms) if (t.replace(/\*/g, '').length < 2) throw new UserError(ctx.t('tooShort', { term: t }));
      conf.update<string[]>('words', (list) => {
        const set = new Set(list ?? []);
        for (const t of terms) add ? set.add(t) : set.delete(t);
        return [...set].sort();
      });
      cache.delete(`${scope}:${id}`);
      return terms.length;
    };

    const listWords = async (ctx: CommandContext, words: string[], title: string) => {
      if (!words.length) return ctx.reply(ctx.t('empty'));
      const pages = pagify(words.map((w) => `\`${w}\``).join(', '), { pageLength: 1800, delims: [', '] });
      try {
        for (const page of pages) await ctx.dm(`**${title}**\n${page}`);
        await ctx.reply(ctx.t('sentDm'));
      } catch {
        await ctx.reply(ctx.t('dmFailed'));
      }
    };

    const perms = { level: 'mod', member: ['ManageMessages'] } as const;

    cog.group({
      name: 'filter',
      description: 'Wortfilter verwalten.',
      guildOnly: true,
      permissions: perms,
      subcommands: [
        {
          name: 'add',
          description: 'Begriffe zum Server-Filter hinzufügen.',
          options: [wordsOpt],
          examples: ['filter add schimpfwort "böse phrase" spam*'],
          run: async (ctx) => {
            await ctx.bot.platform.deleteMessage(ctx.channelId, ctx.message.id).catch(() => undefined);
            await ctx.send(ctx.t('added', { count: editWords(ctx, 'guild', true) }));
          },
        },
        {
          name: 'delete',
          description: 'Begriffe aus dem Server-Filter entfernen.',
          aliases: ['remove', 'del'],
          options: [wordsOpt],
          run: async (ctx) => {
            await ctx.bot.platform.deleteMessage(ctx.channelId, ctx.message.id).catch(() => undefined);
            await ctx.send(ctx.t('removed', { count: editWords(ctx, 'guild', false) }));
          },
        },
        {
          name: 'list',
          description: 'Schickt dir die gefilterten Begriffe per DM.',
          run: (ctx) => listWords(ctx, cog.config.guild(ctx.guildId!).get<string[]>('words'), ctx.t('listTitle', { server: ctx.guild?.name ?? '' })),
        },
        {
          name: 'clear',
          description: 'Leert den Server-Filter.',
          permissions: { level: 'admin', member: ['ManageGuild'] },
          run: async (ctx) => {
            if (!(await ctx.confirm(ctx.t('clearConfirm')))) return ctx.reply(ctx.t('common.cancelled'));
            cog.config.guild(ctx.guildId!).clear('words');
            cache.delete(`guild:${ctx.guildId}`);
            await ctx.tick();
          },
        },
        {
          name: 'channel',
          description: 'Filter nur für diesen Kanal.',
          subcommands: [
            {
              name: 'add',
              description: 'Begriffe zum Kanal-Filter hinzufügen.',
              options: [wordsOpt],
              run: async (ctx) => {
                await ctx.bot.platform.deleteMessage(ctx.channelId, ctx.message.id).catch(() => undefined);
                await ctx.send(ctx.t('added', { count: editWords(ctx, 'channel', true) }));
              },
            },
            {
              name: 'delete',
              description: 'Begriffe aus dem Kanal-Filter entfernen.',
              aliases: ['remove', 'del'],
              options: [wordsOpt],
              run: async (ctx) => {
                await ctx.send(ctx.t('removed', { count: editWords(ctx, 'channel', false) }));
              },
            },
            {
              name: 'list',
              description: 'Begriffe des Kanal-Filters per DM.',
              run: (ctx) => listWords(ctx, cog.config.channel(ctx.channelId).get<string[]>('words'), ctx.t('channelListTitle')),
            },
            {
              name: 'clear',
              description: 'Leert den Kanal-Filter.',
              run: async (ctx) => {
                cog.config.channel(ctx.channelId).clear('words');
                cache.delete(`channel:${ctx.channelId}`);
                await ctx.tick();
              },
            },
          ],
        },
        {
          name: 'names',
          description: 'Nicknames/Benutzernamen mit gefilterten Begriffen ersetzen.',
          permissions: { level: 'admin', member: ['ManageGuild'], bot: ['ManageNicknames'] },
          options: [{ name: 'aktiv', description: 'an/aus', type: OptionType.Boolean, required: true }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('filterNames', ctx.arg<boolean>('aktiv'));
            await ctx.tick();
          },
        },
        {
          name: 'defaultname',
          description: 'Ersatzname für gefilterte Namen.',
          permissions: { level: 'admin', member: ['ManageGuild'] },
          options: [{ name: 'name', description: 'Name', type: OptionType.String, required: true, rest: true, max_length: 32 }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('defaultName', ctx.arg<string>('name'));
            await ctx.tick();
          },
        },
        {
          name: 'ban',
          description: 'Automatisch bannen nach X Treffern in Zeitraum Y ("aus" = deaktivieren).',
          permissions: { level: 'admin', member: ['BanMembers'] },
          options: [
            { name: 'anzahl', description: 'Treffer (oder "aus")', type: OptionType.String, required: true },
            { name: 'zeitraum', description: 'z. B. 10m', type: OptionType.String },
          ],
          examples: ['filter ban 3 10m', 'filter ban aus'],
          run: async (ctx) => {
            const raw = ctx.arg<string>('anzahl');
            const conf = cog.config.guild(ctx.guildId!);
            if (['aus', 'off', '0'].includes(raw.toLowerCase())) {
              conf.setAll({ banCount: 0, banSeconds: 0 });
              return ctx.reply(ctx.t('banOff'));
            }
            const count = Number(raw);
            const seconds = takeDuration(ctx.arg<string | undefined>('zeitraum') ?? '').seconds;
            if (!Number.isInteger(count) || count < 1 || !seconds) throw new UserError(ctx.t('banUsage'));
            conf.setAll({ banCount: count, banSeconds: seconds });
            await ctx.reply(ctx.t('banOn', { count, time: humanizeSeconds(seconds) }));
          },
        },
      ],
    });
  },
});
