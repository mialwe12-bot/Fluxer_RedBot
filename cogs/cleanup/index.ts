import { defineCog, OptionType, parseMessageRef, UserError, type APIMessage, type Cog, type CommandContext, type ResolvedUser } from '@bot/sdk';

const MAX = 1000;
const CONFIRM_ABOVE = 100;
/** Bulk-Delete nur für jüngere Nachrichten (Discord: 14 Tage; für Fluxer angenommen, sonst Einzel-Löschung). */
const BULK_MAX_AGE = 14 * 86400 * 1000 - 60_000;

type Filter = (m: APIMessage) => boolean;

export default defineCog({
  setup(cog: Cog) {
    const p = () => cog.platform;

    /**
     * Holt Nachrichten (neueste zuerst) und sammelt bis zu `limit` passende.
     * `before`/`after` begrenzen den Bereich; `scan` begrenzt, wie viele insgesamt gelesen werden.
     */
    async function collect(channelId: string, filter: Filter, limit: number, opts: { before?: string; after?: string; scan?: number } = {}): Promise<APIMessage[]> {
      const found: APIMessage[] = [];
      let before = opts.before;
      let scanned = 0;
      const maxScan = opts.scan ?? Math.max(limit * 5, 200);
      while (found.length < limit && scanned < maxScan) {
        const batch = await p().fetchMessages(channelId, { limit: 100, ...(before ? { before } : {}) });
        if (!batch?.length) break;
        for (const m of batch) {
          scanned++;
          if (opts.after && BigInt(m.id) <= BigInt(opts.after)) return found;
          if (filter(m)) found.push(m);
          if (found.length >= limit) break;
        }
        before = batch[batch.length - 1]!.id;
        if (batch.length < 100) break;
      }
      return found;
    }

    /** Löscht Nachrichten: Bulk in 100er-Blöcken, ältere oder bei Fehler einzeln. */
    async function remove(channelId: string, messages: Array<Pick<APIMessage, 'id' | 'timestamp'>>): Promise<number> {
      const now = Date.now();
      const young = messages.filter((m) => !m.timestamp || now - new Date(m.timestamp).getTime() < BULK_MAX_AGE).map((m) => m.id);
      const old = messages.filter((m) => m.timestamp && now - new Date(m.timestamp).getTime() >= BULK_MAX_AGE).map((m) => m.id);
      let deleted = 0;
      const single = async (ids: string[]) => {
        for (const id of ids) {
          try {
            await p().deleteMessage(channelId, id);
            deleted++;
          } catch {
            /* bereits gelöscht oder nicht erlaubt */
          }
        }
      };
      for (let i = 0; i < young.length; i += 100) {
        const chunk = young.slice(i, i + 100);
        try {
          await p().bulkDeleteMessages(channelId, chunk);
          deleted += chunk.length;
        } catch {
          await single(chunk);
        }
      }
      await single(old);
      return deleted;
    }

    async function run(ctx: CommandContext, filter: Filter, count: number, opts: { before?: string; after?: string; includeCommand?: boolean } = {}) {
      if (count < 1 || count > MAX) throw new UserError(ctx.t('badCount', { max: MAX }));
      if (count > CONFIRM_ABOVE && !(await ctx.confirm(ctx.t('confirmMany', { count })))) return ctx.reply(ctx.t('common.cancelled'));
      await ctx.typing();
      // Die Befehlsnachricht selbst nicht mitzählen, aber mitlöschen.
      const commandId = ctx.message.id;
      const messages = await collect(ctx.channelId, (m) => m.id !== commandId && filter(m), count, {
        before: opts.before ?? commandId,
        ...(opts.after ? { after: opts.after } : {}),
      });
      const toDelete = [...messages];
      if (opts.includeCommand !== false) toDelete.push({ ...ctx.message });
      const deleted = await remove(ctx.channelId, toDelete);
      cog.log.info({ guild: ctx.guildId, channel: ctx.channelId, by: ctx.author.id, deleted }, 'cleanup');
      const info = await ctx.send(ctx.t('done', { count: Math.max(0, deleted - (opts.includeCommand !== false ? 1 : 0)) }));
      setTimeout(() => void p().deleteMessage(info.channel_id, info.id).catch(() => undefined), 5000).unref();
    }

    const perms = { level: 'mod', member: ['ManageMessages'], bot: ['ManageMessages', 'ReadMessageHistory'] } as const;
    const countOpt = { name: 'anzahl', description: `Anzahl (1–${MAX})`, type: OptionType.Integer, required: true, min_value: 1, max_value: MAX } as const;
    const prefixes = (ctx: CommandContext) => ctx.bot.prefixesFor(ctx.guildId);

    cog.group({
      name: 'cleanup',
      description: 'Nachrichten aufräumen.',
      aliases: ['purge', 'clear'],
      guildOnly: true,
      permissions: perms,
      subcommands: [
        {
          name: 'messages',
          description: 'Löscht die letzten N Nachrichten.',
          aliases: ['nachrichten', 'n'],
          options: [countOpt],
          run: (ctx) => run(ctx, () => true, ctx.arg<number>('anzahl')),
        },
        {
          name: 'user',
          description: 'Löscht die letzten N Nachrichten eines Benutzers.',
          options: [{ name: 'user', description: 'Benutzer (auch ID)', type: OptionType.User, required: true }, countOpt],
          run: (ctx) => run(ctx, (m) => m.author.id === ctx.arg<ResolvedUser>('user').id, ctx.arg<number>('anzahl')),
        },
        {
          name: 'text',
          description: 'Löscht die letzten N Nachrichten, die einen Text enthalten.',
          options: [countOpt, { name: 'text', description: 'Gesuchter Text', type: OptionType.String, required: true, rest: true }],
          examples: ['cleanup text 20 discord.gg'],
          run: (ctx) => {
            const needle = ctx.arg<string>('text').toLowerCase();
            return run(ctx, (m) => (m.content ?? '').toLowerCase().includes(needle), ctx.arg<number>('anzahl'));
          },
        },
        {
          name: 'bot',
          description: 'Löscht Bot-Nachrichten und Befehlsaufrufe.',
          options: [countOpt],
          run: (ctx) =>
            run(
              ctx,
              (m) => Boolean((m.author as { bot?: boolean }).bot) || prefixes(ctx).some((pre) => (m.content ?? '').startsWith(pre)),
              ctx.arg<number>('anzahl'),
            ),
        },
        {
          name: 'self',
          description: 'Löscht meine eigenen Nachrichten.',
          options: [countOpt],
          run: (ctx) => run(ctx, (m) => m.author.id === p().user?.id, ctx.arg<number>('anzahl')),
        },
        {
          name: 'duplicates',
          description: 'Löscht doppelte Nachrichten (Spam) unter den letzten N.',
          aliases: ['spam'],
          options: [countOpt],
          run: (ctx) => {
            const seen = new Set<string>();
            return run(
              ctx,
              (m) => {
                const key = `${m.author.id}|${(m.content ?? '').trim().toLowerCase()}|${(m.embeds ?? []).length}`;
                if (!m.content && !(m.embeds ?? []).length) return false;
                if (seen.has(key)) return true;
                seen.add(key);
                return false;
              },
              ctx.arg<number>('anzahl'),
            );
          },
        },
        {
          name: 'after',
          description: 'Löscht alles nach einer Nachricht (Link oder ID).',
          options: [{ name: 'nachricht', description: 'Nachrichten-Link oder -ID', type: OptionType.String, required: true }],
          run: (ctx) => {
            const ref = parseMessageRef(ctx.arg<string>('nachricht'), ctx.channelId);
            if (!ref || ref.channelId !== ctx.channelId) throw new UserError(ctx.t('badRef'));
            return run(ctx, () => true, MAX, { after: ref.messageId });
          },
        },
        {
          name: 'before',
          description: 'Löscht N Nachrichten vor einer Nachricht.',
          options: [{ name: 'nachricht', description: 'Nachrichten-Link oder -ID', type: OptionType.String, required: true }, countOpt],
          run: (ctx) => {
            const ref = parseMessageRef(ctx.arg<string>('nachricht'), ctx.channelId);
            if (!ref || ref.channelId !== ctx.channelId) throw new UserError(ctx.t('badRef'));
            return run(ctx, () => true, ctx.arg<number>('anzahl'), { before: ref.messageId });
          },
        },
        {
          name: 'between',
          description: 'Löscht alles zwischen zwei Nachrichten (exklusiv).',
          options: [
            { name: 'von', description: 'Ältere Nachricht', type: OptionType.String, required: true },
            { name: 'bis', description: 'Neuere Nachricht', type: OptionType.String, required: true },
          ],
          run: (ctx) => {
            const a = parseMessageRef(ctx.arg<string>('von'), ctx.channelId);
            const b = parseMessageRef(ctx.arg<string>('bis'), ctx.channelId);
            if (!a || !b || a.channelId !== ctx.channelId || b.channelId !== ctx.channelId) throw new UserError(ctx.t('badRef'));
            const [older, newer] = BigInt(a.messageId) < BigInt(b.messageId) ? [a, b] : [b, a];
            return run(ctx, () => true, MAX, { before: newer.messageId, after: older.messageId });
          },
        },
      ],
    });
  },
});
