import {
  defineCog,
  embed,
  formatDateTime,
  OptionType,
  PermissionFlags as F,
  sameEmoji,
  UserError,
  type APIMessage,
  type APIRole,
  type Cog,
  type CommandContext,
  type ReactionEvent,
  type ResolvedUser,
} from '@bot/sdk';

interface Ticket {
  owner: string;
  number: number;
  reason: string | null;
  createdAt: number;
  added: string[];
}

const USER_ALLOW = F.ViewChannel | F.SendMessages | F.ReadMessageHistory | F.AttachFiles | F.EmbedLinks | F.AddReactions;
const BOT_ALLOW = USER_ALLOW | F.ManageChannels | F.ManageMessages;

/** Protokoll eines Ticket-Kanals als Text (älteste Nachricht zuerst). */
export function transcript(messages: Array<Pick<APIMessage, 'author' | 'content' | 'timestamp' | 'attachments' | 'embeds'>>, header: string): string {
  const lines = [header, ''];
  for (const m of [...messages].reverse()) {
    const time = m.timestamp ? formatDateTime(new Date(m.timestamp)) : '';
    const att = (m.attachments ?? []).map((a) => ` [Anhang: ${a.url ?? a.filename}]`).join('');
    const emb = (m.embeds ?? []).map((e) => ` [Embed: ${e.title ?? ''} ${e.description ?? ''}]`).join('');
    lines.push(`[${time}] ${m.author.username}: ${m.content ?? ''}${att}${emb}`);
  }
  return lines.join('\n');
}

export default defineCog({
  setup(cog: Cog) {
    cog.config.registerGuild({
      enabled: true,
      category: null as string | null,
      supportRoles: [] as string[],
      logChannel: null as string | null,
      panel: null as { channelId: string; messageId: string } | null,
      emoji: '🎫',
      maxOpen: 1,
      message: 'Hallo {user}! Das Team meldet sich gleich bei dir.\nGrund: {reason}\n\nSchließen mit `{prefix}ticket close`.',
      counter: 0,
    });
    cog.config.registerChannel({ ticket: null as Ticket | null });
    const p = () => cog.platform;

    const openTickets = (guildId: string): Array<{ channelId: string; ticket: Ticket }> => {
      const g = p().getGuild(guildId);
      const out: Array<{ channelId: string; ticket: Ticket }> = [];
      for (const [channelId, data] of Object.entries(cog.config.allChannels<{ ticket: Ticket | null }>())) {
        if (data.ticket && g?.channels.has(channelId)) out.push({ channelId, ticket: data.ticket });
      }
      return out;
    };

    async function open(guildId: string, userId: string, reason: string | null): Promise<string> {
      const conf = cog.config.guild(guildId);
      if (!conf.get<boolean>('enabled')) throw new UserError(cog.tg(guildId, 'disabled'));
      const mine = openTickets(guildId).filter((t) => t.ticket.owner === userId);
      if (mine.length >= conf.get<number>('maxOpen')) throw new UserError(cog.tg(guildId, 'tooMany', { channel: `<#${mine[0]!.channelId}>` }));
      const number = conf.update<number>('counter', (n) => (n ?? 0) + 1);
      const botId = p().user?.id ?? '';
      const overwrites = [
        { id: guildId, type: 0 as const, allow: '0', deny: F.ViewChannel.toString() },
        { id: userId, type: 1 as const, allow: USER_ALLOW.toString(), deny: '0' },
        { id: botId, type: 1 as const, allow: BOT_ALLOW.toString(), deny: '0' },
        ...conf.get<string[]>('supportRoles').map((r) => ({ id: r, type: 0 as const, allow: USER_ALLOW.toString(), deny: '0' })),
      ];
      const channel = await p().createGuildChannel(
        guildId,
        {
          name: `ticket-${String(number).padStart(4, '0')}`,
          type: 0,
          parent_id: conf.get<string | null>('category'),
          topic: cog.tg(guildId, 'topic', { user: p().users.get(userId)?.username ?? userId, reason: reason ?? '–' }),
          permission_overwrites: overwrites,
        },
        `Ticket ${number}`,
      );
      cog.config.channel(channel.id).set('ticket', { owner: userId, number, reason, createdAt: Date.now(), added: [] } satisfies Ticket);
      const text = conf
        .get<string>('message')
        .replace(/\{user\}/g, `<@${userId}>`)
        .replace(/\{reason\}/g, reason ?? '–')
        .replace(/\{prefix\}/g, cog.bot.prefixesFor(guildId)[0] ?? '!');
      const roles = conf.get<string[]>('supportRoles');
      await cog.bot.send(channel.id, { content: `${text}${roles.length ? `\n${roles.map((r) => `<@&${r}>`).join(' ')}` : ''}`, allowed_mentions: { users: [userId], roles } }, guildId);
      return channel.id;
    }

    async function close(guildId: string, channelId: string, closedBy: string, reason: string | null): Promise<void> {
      const ticket = cog.config.channel(channelId).get<Ticket | null>('ticket');
      if (!ticket) return;
      const log = cog.config.guild(guildId).get<string | null>('logChannel');
      if (log) {
        const messages: APIMessage[] = [];
        let before: string | undefined;
        for (let i = 0; i < 5; i++) {
          const batch = (await p().fetchMessages(channelId, { limit: 100, ...(before ? { before } : {}) }).catch(() => [])) ?? [];
          messages.push(...batch);
          if (batch.length < 100) break;
          before = batch[batch.length - 1]!.id;
        }
        const header = cog.tg(guildId, 'transcriptHeader', { number: ticket.number, owner: ticket.owner, opened: formatDateTime(ticket.createdAt), closed: formatDateTime(new Date()) });
        const e = embed({
          title: cog.tg(guildId, 'closedTitle', { number: ticket.number }),
          fields: [
            { name: cog.tg(guildId, 'owner'), value: `<@${ticket.owner}>`, inline: true },
            { name: cog.tg(guildId, 'closedBy'), value: `<@${closedBy}>`, inline: true },
            { name: cog.tg(guildId, 'reason'), value: ticket.reason ?? '–' },
            { name: cog.tg(guildId, 'closeReason'), value: reason ?? '–' },
          ],
          color: 0x95a5a6,
        });
        await cog.bot
          .send(log, {
            ...(await cog.bot.adaptPayload({ embeds: [e] }, guildId, log)),
            files: [{ name: `ticket-${ticket.number}.txt`, data: Buffer.from(transcript(messages, header), 'utf8') }],
          })
          .catch((err) => cog.log.warn({ err }, 'Ticket-Protokoll konnte nicht gesendet werden'));
      }
      cog.config.channel(channelId).clear();
      await p().deleteChannel(channelId, `Ticket ${ticket.number} geschlossen`);
    }

    const requireTicket = (ctx: CommandContext): Ticket => {
      const t = cog.config.channel(ctx.channelId).get<Ticket | null>('ticket');
      if (!t) throw new UserError(ctx.t('notATicket'));
      return t;
    };
    const isSupport = async (ctx: CommandContext): Promise<boolean> => {
      const roles = cog.config.guild(ctx.guildId!).get<string[]>('supportRoles');
      if (ctx.member?.roles.some((r) => roles.includes(r))) return true;
      return ['mod', 'admin', 'guildowner', 'owner'].includes(await ctx.bot.levelOf(ctx.guildId, ctx.author.id));
    };

    // Panel-Reaktion → Ticket
    cog.on('MESSAGE_REACTION_ADD', async (e: ReactionEvent) => {
      if (!e.guild_id || e.user_id === p().user?.id) return;
      const conf = cog.config.guild(e.guild_id);
      const panel = conf.get<{ channelId: string; messageId: string } | null>('panel');
      if (!panel || panel.messageId !== e.message_id || !sameEmoji(conf.get<string>('emoji'), e.emoji)) return;
      await p().removeReaction(e.channel_id, e.message_id, conf.get<string>('emoji'), e.user_id).catch(() => undefined);
      try {
        await open(e.guild_id, e.user_id, null);
      } catch (err) {
        await p().sendDM(e.user_id, (err as Error).message).catch(() => undefined);
      }
    });

    cog.on('CHANNEL_DELETE', (c: { id: string }) => cog.config.channel(c.id).clear());

    cog.group({
      name: 'ticket',
      description: 'Support-Tickets.',
      guildOnly: true,
      subcommands: [
        {
          name: 'new',
          description: 'Öffnet ein neues Ticket.',
          aliases: ['open', 'neu'],
          cooldown: { rate: 2, per: 60, bucket: 'member' },
          permissions: { level: 'everyone', bot: ['ManageChannels'] },
          options: [{ name: 'grund', description: 'Worum geht es?', type: OptionType.String, rest: true, max_length: 500 }],
          run: async (ctx) => {
            const id = await open(ctx.guildId!, ctx.author.id, ctx.arg<string | undefined>('grund') ?? null);
            await ctx.reply(ctx.t('opened', { channel: `<#${id}>` }));
          },
        },
        {
          name: 'close',
          description: 'Schließt dieses Ticket (Ersteller oder Team).',
          aliases: ['schließen', 'schliessen'],
          options: [{ name: 'grund', description: 'Grund', type: OptionType.String, rest: true }],
          run: async (ctx) => {
            const t = requireTicket(ctx);
            if (t.owner !== ctx.author.id && !(await isSupport(ctx))) throw new UserError(ctx.t('notAllowed'));
            await ctx.send(ctx.t('closing'));
            await close(ctx.guildId!, ctx.channelId, ctx.author.id, ctx.arg<string | undefined>('grund') ?? null);
          },
        },
        {
          name: 'add',
          description: 'Fügt jemanden zum Ticket hinzu.',
          options: [{ name: 'user', description: 'Mitglied', type: OptionType.User, required: true }],
          run: async (ctx) => {
            const t = requireTicket(ctx);
            if (t.owner !== ctx.author.id && !(await isSupport(ctx))) throw new UserError(ctx.t('notAllowed'));
            const user = ctx.arg<ResolvedUser>('user');
            await p().setChannelOverwrite(ctx.channelId, user.id, { type: 1, allow: USER_ALLOW, deny: 0n }, 'ticket add');
            cog.config.channel(ctx.channelId).set('ticket', { ...t, added: [...new Set([...t.added, user.id])] });
            await ctx.reply(ctx.t('added', { user: `<@${user.id}>` }));
          },
        },
        {
          name: 'remove',
          description: 'Entfernt jemanden aus dem Ticket.',
          options: [{ name: 'user', description: 'Mitglied', type: OptionType.User, required: true }],
          run: async (ctx) => {
            const t = requireTicket(ctx);
            if (!(await isSupport(ctx))) throw new UserError(ctx.t('notAllowed'));
            const user = ctx.arg<ResolvedUser>('user');
            if (user.id === t.owner) throw new UserError(ctx.t('cantRemoveOwner'));
            await p().deleteChannelOverwrite(ctx.channelId, user.id, 'ticket remove').catch(() => undefined);
            cog.config.channel(ctx.channelId).set('ticket', { ...t, added: t.added.filter((u) => u !== user.id) });
            await ctx.tick();
          },
        },
        {
          name: 'list',
          description: 'Offene Tickets (Team).',
          permissions: { level: 'mod', member: ['ManageChannels'] },
          run: async (ctx) => {
            const list = openTickets(ctx.guildId!);
            await ctx.reply(
              list.length
                ? list.map((t) => `#${t.ticket.number} <#${t.channelId}> – <@${t.ticket.owner}> – ${formatDateTime(t.ticket.createdAt)}`).join('\n')
                : ctx.t('noneOpen'),
            );
          },
        },
      ],
    });

    cog.group({
      name: 'ticketset',
      description: 'Tickets einrichten.',
      guildOnly: true,
      permissions: { level: 'admin', member: ['ManageGuild'] },
      subcommands: [
        {
          name: 'panel',
          description: 'Postet das Ticket-Panel (Reaktion öffnet ein Ticket).',
          options: [
            { name: 'kanal', description: 'Kanal', type: OptionType.Channel, required: true, channel_types: [0, 5] },
            { name: 'text', description: 'Panel-Text', type: OptionType.String, rest: true },
          ],
          run: async (ctx) => {
            const channel = ctx.arg<{ id: string }>('kanal').id;
            const conf = cog.config.guild(ctx.guildId!);
            const emoji = conf.get<string>('emoji');
            const e = embed({ title: ctx.t('panelTitle'), description: ctx.arg<string | undefined>('text') ?? ctx.t('panelText', { emoji }), color: 0x3498db });
            const msg = await ctx.bot.send(channel, await ctx.bot.adaptPayload({ embeds: [e] }, ctx.guildId, channel), ctx.guildId);
            await p().addReaction(channel, msg.id, emoji).catch(() => undefined);
            conf.set('panel', { channelId: channel, messageId: msg.id });
            await ctx.tick();
          },
        },
        {
          name: 'supportrole',
          description: 'Support-Rolle hinzufügen/entfernen (umschalten).',
          options: [{ name: 'rolle', description: 'Rolle', type: OptionType.Role, required: true }],
          run: async (ctx) => {
            const id = ctx.arg<APIRole>('rolle').id;
            let added = false;
            cog.config.guild(ctx.guildId!).update<string[]>('supportRoles', (l) => {
              added = !l.includes(id);
              return added ? [...l, id] : l.filter((r) => r !== id);
            });
            await ctx.reply(ctx.t(added ? 'roleAdded' : 'roleRemoved'));
          },
        },
        {
          name: 'category',
          description: 'Kategorie für Ticket-Kanäle (leer = keine).',
          options: [{ name: 'kategorie', description: 'Kategorie', type: OptionType.Channel, channel_types: [4] }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('category', ctx.arg<{ id: string } | undefined>('kategorie')?.id ?? null);
            await ctx.tick();
          },
        },
        {
          name: 'log',
          description: 'Kanal für Protokolle geschlossener Tickets (leer = keiner).',
          options: [{ name: 'kanal', description: 'Kanal', type: OptionType.Channel, channel_types: [0, 5] }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('logChannel', ctx.arg<{ id: string } | undefined>('kanal')?.id ?? null);
            await ctx.tick();
          },
        },
        {
          name: 'max',
          description: 'Wie viele offene Tickets pro Person.',
          options: [{ name: 'anzahl', description: 'Anzahl', type: OptionType.Integer, required: true, min_value: 1, max_value: 10 }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('maxOpen', ctx.arg<number>('anzahl'));
            await ctx.tick();
          },
        },
        {
          name: 'message',
          description: 'Begrüßung im Ticket ({user}, {reason}, {prefix}).',
          options: [{ name: 'text', description: 'Text', type: OptionType.String, required: true, rest: true, max_length: 1500 }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('message', ctx.arg<string>('text'));
            await ctx.tick();
          },
        },
        {
          name: 'toggle',
          description: 'Tickets an/aus.',
          options: [{ name: 'aktiv', description: 'an/aus', type: OptionType.Boolean, required: true }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('enabled', ctx.arg<boolean>('aktiv'));
            await ctx.tick();
          },
        },
      ],
    });
  },
});
