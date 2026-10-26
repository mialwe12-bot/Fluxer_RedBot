import {
  defineCog,
  embed,
  OptionType,
  type APIChannel,
  type APIGuildMember,
  type APIRole,
  type APIVoiceState,
  type CachedMessage,
  type Cog,
  type CommandContext,
  type EmbedInput,
} from '@bot/sdk';

export const EVENTS = [
  'messageDelete',
  'messageEdit',
  'memberJoin',
  'memberLeave',
  'memberBan',
  'memberUnban',
  'nicknameChange',
  'memberRoles',
  'roleCreate',
  'roleDelete',
  'roleUpdate',
  'channelCreate',
  'channelDelete',
  'channelUpdate',
  'voiceChange',
  'inviteCreate',
  'commandUsed',
] as const;
export type LogEvent = (typeof EVENTS)[number];

interface EventSetting {
  enabled: boolean;
  channel: string | null;
}

const COLORS: Partial<Record<LogEvent, number>> = {
  messageDelete: 0xe74c3c,
  messageEdit: 0xf39c12,
  memberJoin: 0x2ecc71,
  memberLeave: 0x95a5a6,
  memberBan: 0xc0392b,
  memberUnban: 0x27ae60,
  voiceChange: 0x9b59b6,
};

export default defineCog({
  setup(cog: Cog) {
    const defaults = Object.fromEntries(EVENTS.map((e) => [e, { enabled: false, channel: null }])) as Record<LogEvent, EventSetting>;
    cog.config.registerGuild({
      channel: null as string | null,
      events: defaults,
      ignoredChannels: [] as string[],
      ignoreBots: true,
    });
    const p = () => cog.platform;

    const settingFor = (guildId: string, event: LogEvent): EventSetting => {
      const stored = cog.config.guild(guildId).get<Record<string, EventSetting>>('events')[event];
      return { ...defaults[event], ...(stored ?? {}) };
    };

    /** Sendet einen Log-Eintrag, wenn das Event aktiv ist und ein Kanal feststeht. */
    async function log(guildId: string | undefined | null, event: LogEvent, input: EmbedInput, sourceChannel?: string): Promise<void> {
      if (!guildId) return;
      const conf = cog.config.guild(guildId);
      const s = settingFor(guildId, event);
      if (!s.enabled) return;
      if (sourceChannel) {
        const ignored = conf.get<string[]>('ignoredChannels');
        const parent = p().getChannel(sourceChannel)?.parent_id;
        if (ignored.includes(sourceChannel) || (parent && ignored.includes(parent))) return;
      }
      const target = s.channel ?? conf.get<string | null>('channel');
      if (!target || target === sourceChannel) return;
      const e = embed({ color: COLORS[event] ?? 0x3498db, timestamp: new Date(), ...input });
      try {
        await cog.bot.send(target, await cog.bot.adaptPayload({ embeds: [e], allowed_mentions: { parse: [] } }, guildId, target), guildId);
      } catch (err) {
        cog.log.debug({ err, guildId, event }, 'Log-Eintrag konnte nicht gesendet werden');
      }
    }

    const t = (guildId: string | undefined | null, key: string, vars?: Record<string, string | number>) => cog.tg(guildId ?? undefined, key, vars);
    const ignoreBot = (guildId: string, isBot: boolean | undefined) => Boolean(isBot) && cog.config.guild(guildId).get<boolean>('ignoreBots');
    const userLine = (u: { id: string; username?: string }) => `<@${u.id}> (${u.username ?? '?'}, \`${u.id}\`)`;

    // ------------------------------------------------------------------ Nachrichten
    cog.on('MESSAGE_DELETE', (d: { id: string; channel_id: string; guild_id?: string }, cached?: CachedMessage) => {
      if (!d.guild_id) return;
      if (cached && ignoreBot(d.guild_id, cached.author.bot)) return;
      const g = d.guild_id;
      return log(
        g,
        'messageDelete',
        {
          title: t(g, 'titles.messageDelete'),
          description: cached ? cached.content.slice(0, 3800) || t(g, 'noContent') : t(g, 'notCached'),
          fields: [
            ...(cached ? [{ name: t(g, 'author'), value: userLine(cached.author), inline: true }] : []),
            { name: t(g, 'channel'), value: `<#${d.channel_id}>`, inline: true },
            ...(cached?.attachments.length ? [{ name: t(g, 'attachments'), value: cached.attachments.join('\n').slice(0, 1000) }] : []),
          ],
          footer: `ID ${d.id}`,
        },
        d.channel_id,
      );
    });

    cog.on('MESSAGE_DELETE_BULK', (d: { ids: string[]; channel_id: string; guild_id?: string }, cached?: CachedMessage[]) => {
      if (!d.guild_id) return;
      const g = d.guild_id;
      const sample = (cached ?? [])
        .slice(-10)
        .map((m) => `**${m.author.username}:** ${m.content.slice(0, 150)}`)
        .join('\n');
      return log(g, 'messageDelete', { title: t(g, 'titles.bulkDelete', { count: d.ids.length }), description: `<#${d.channel_id}>\n${sample}`.slice(0, 3800) }, d.channel_id);
    });

    cog.on('MESSAGE_UPDATE', (d: { id: string; channel_id: string; guild_id?: string; content?: string; author?: { id: string; username: string; bot?: boolean } }, before?: CachedMessage) => {
      if (!d.guild_id || typeof d.content !== 'string' || !before || before.content === d.content) return;
      if (ignoreBot(d.guild_id, before.author.bot)) return;
      const g = d.guild_id;
      return log(
        g,
        'messageEdit',
        {
          title: t(g, 'titles.messageEdit'),
          fields: [
            { name: t(g, 'before'), value: before.content.slice(0, 1000) || t(g, 'noContent') },
            { name: t(g, 'after'), value: d.content.slice(0, 1000) || t(g, 'noContent') },
            { name: t(g, 'author'), value: userLine(before.author), inline: true },
            { name: t(g, 'channel'), value: `<#${d.channel_id}>`, inline: true },
          ],
          footer: `ID ${d.id}`,
        },
        d.channel_id,
      );
    });

    // ------------------------------------------------------------------ Mitglieder
    cog.on('GUILD_MEMBER_ADD', (m: APIGuildMember & { guild_id: string }) => {
      if (ignoreBot(m.guild_id, (m.user as { bot?: boolean }).bot)) return;
      return log(m.guild_id, 'memberJoin', {
        title: t(m.guild_id, 'titles.memberJoin'),
        description: userLine(m.user),
        footer: t(m.guild_id, 'memberCount', { count: p().getGuild(m.guild_id)?.member_count ?? 0 }),
      });
    });

    cog.on('GUILD_MEMBER_REMOVE', (d: { guild_id: string; user: { id: string; username: string; bot?: boolean } }, previous?: APIGuildMember) => {
      if (ignoreBot(d.guild_id, d.user.bot)) return;
      const roles = (previous?.roles ?? []).map((r) => `<@&${r}>`).join(' ');
      return log(d.guild_id, 'memberLeave', {
        title: t(d.guild_id, 'titles.memberLeave'),
        description: userLine(d.user),
        fields: roles ? [{ name: t(d.guild_id, 'roles'), value: roles.slice(0, 1000) }] : [],
      });
    });

    cog.on('GUILD_BAN_ADD', (d: { guild_id: string; user: { id: string; username: string } }) =>
      log(d.guild_id, 'memberBan', { title: t(d.guild_id, 'titles.memberBan'), description: userLine(d.user) }),
    );
    cog.on('GUILD_BAN_REMOVE', (d: { guild_id: string; user: { id: string; username: string } }) =>
      log(d.guild_id, 'memberUnban', { title: t(d.guild_id, 'titles.memberUnban'), description: userLine(d.user) }),
    );

    cog.on('GUILD_MEMBER_UPDATE', async (m: APIGuildMember & { guild_id: string }, before?: APIGuildMember) => {
      if (!before) return;
      const g = m.guild_id;
      if ((before.nick ?? null) !== (m.nick ?? null)) {
        await log(g, 'nicknameChange', {
          title: t(g, 'titles.nicknameChange'),
          description: userLine(m.user),
          fields: [
            { name: t(g, 'before'), value: before.nick ?? '–', inline: true },
            { name: t(g, 'after'), value: m.nick ?? '–', inline: true },
          ],
        });
      }
      const added = (m.roles ?? []).filter((r) => !(before.roles ?? []).includes(r));
      const removed = (before.roles ?? []).filter((r) => !(m.roles ?? []).includes(r));
      if (added.length || removed.length) {
        await log(g, 'memberRoles', {
          title: t(g, 'titles.memberRoles'),
          description: userLine(m.user),
          fields: [
            ...(added.length ? [{ name: t(g, 'added'), value: added.map((r) => `<@&${r}>`).join(' '), inline: true }] : []),
            ...(removed.length ? [{ name: t(g, 'removed'), value: removed.map((r) => `<@&${r}>`).join(' '), inline: true }] : []),
          ],
        });
      }
    });

    // ------------------------------------------------------------------ Rollen & Kanäle
    cog.on('GUILD_ROLE_CREATE', (d: { guild_id: string; role: APIRole }) =>
      log(d.guild_id, 'roleCreate', { title: t(d.guild_id, 'titles.roleCreate'), description: `**${d.role.name}** (\`${d.role.id}\`)` }),
    );
    cog.on('GUILD_ROLE_DELETE', (d: { guild_id: string; role_id: string }, previous?: APIRole) =>
      log(d.guild_id, 'roleDelete', { title: t(d.guild_id, 'titles.roleDelete'), description: `**${previous?.name ?? '?'}** (\`${d.role_id}\`)` }),
    );
    cog.on('GUILD_ROLE_UPDATE', (d: { guild_id: string; role: APIRole }, previous?: APIRole) => {
      if (!previous) return;
      const changes: string[] = [];
      if (previous.name !== d.role.name) changes.push(`${t(d.guild_id, 'fields.name')}: ${previous.name} → ${d.role.name}`);
      if (previous.color !== d.role.color) changes.push(`${t(d.guild_id, 'fields.color')}: #${previous.color.toString(16).padStart(6, '0')} → #${d.role.color.toString(16).padStart(6, '0')}`);
      if (previous.permissions !== d.role.permissions) changes.push(t(d.guild_id, 'fields.permissions'));
      if (previous.hoist !== d.role.hoist) changes.push(`${t(d.guild_id, 'fields.hoist')}: ${d.role.hoist ? '✅' : '❌'}`);
      if (previous.mentionable !== d.role.mentionable) changes.push(`${t(d.guild_id, 'fields.mentionable')}: ${d.role.mentionable ? '✅' : '❌'}`);
      if (!changes.length) return;
      return log(d.guild_id, 'roleUpdate', { title: t(d.guild_id, 'titles.roleUpdate'), description: `<@&${d.role.id}>\n${changes.join('\n')}` });
    });

    cog.on('CHANNEL_CREATE', (c: APIChannel) =>
      c.guild_id ? log(c.guild_id, 'channelCreate', { title: t(c.guild_id, 'titles.channelCreate'), description: `<#${c.id}> (${c.name ?? '?'})` }) : undefined,
    );
    cog.on('CHANNEL_DELETE', (c: APIChannel, previous?: APIChannel) => {
      const g = c.guild_id ?? previous?.guild_id;
      return g ? log(g, 'channelDelete', { title: t(g, 'titles.channelDelete'), description: `#${previous?.name ?? c.name ?? '?'} (\`${c.id}\`)` }) : undefined;
    });
    cog.on('CHANNEL_UPDATE', (c: APIChannel, previous?: APIChannel) => {
      const g = c.guild_id;
      if (!g || !previous) return;
      const changes: string[] = [];
      if (previous.name !== c.name) changes.push(`${t(g, 'fields.name')}: ${previous.name} → ${c.name}`);
      if ((previous.topic ?? '') !== (c.topic ?? '')) changes.push(`${t(g, 'fields.topic')}: ${previous.topic ?? '–'} → ${c.topic ?? '–'}`);
      if ((previous.rate_limit_per_user ?? 0) !== (c.rate_limit_per_user ?? 0)) changes.push(`${t(g, 'fields.slowmode')}: ${previous.rate_limit_per_user ?? 0}s → ${c.rate_limit_per_user ?? 0}s`);
      if (JSON.stringify(previous.permission_overwrites ?? []) !== JSON.stringify(c.permission_overwrites ?? [])) changes.push(t(g, 'fields.overwrites'));
      if (!changes.length) return;
      return log(g, 'channelUpdate', { title: t(g, 'titles.channelUpdate'), description: `<#${c.id}>\n${changes.join('\n')}` });
    });

    // ------------------------------------------------------------------ Voice & Einladungen
    cog.on('VOICE_STATE_UPDATE', (s: APIVoiceState, before?: APIVoiceState) => {
      const g = s.guild_id;
      if (!g || (before?.channel_id ?? null) === (s.channel_id ?? null)) return;
      if (ignoreBot(g, (s.member?.user as { bot?: boolean } | undefined)?.bot)) return;
      const user = `<@${s.user_id}>`;
      const key = !before?.channel_id ? 'voiceJoin' : !s.channel_id ? 'voiceLeave' : 'voiceMove';
      return log(g, 'voiceChange', {
        title: t(g, `titles.${key}`),
        description: t(g, `voice.${key}`, { user, from: before?.channel_id ? `<#${before.channel_id}>` : '', to: s.channel_id ? `<#${s.channel_id}>` : '' }),
      });
    });

    cog.on('INVITE_CREATE', (d: { guild_id?: string; code: string; channel_id?: string; inviter?: { id: string; username: string }; max_uses?: number; max_age?: number }) => {
      if (!d.guild_id) return;
      return log(d.guild_id, 'inviteCreate', {
        title: t(d.guild_id, 'titles.inviteCreate'),
        description: `\`${d.code}\`${d.channel_id ? ` → <#${d.channel_id}>` : ''}`,
        fields: d.inviter ? [{ name: t(d.guild_id, 'author'), value: userLine(d.inviter) }] : [],
      });
    });

    cog.on('commandCompleted', (ctx: CommandContext) => {
      if (!ctx.guildId) return;
      return log(
        ctx.guildId,
        'commandUsed',
        { title: t(ctx.guildId, 'titles.commandUsed'), description: `${userLine(ctx.author)}\n\`${ctx.message.content.slice(0, 500)}\``, fields: [{ name: t(ctx.guildId, 'channel'), value: `<#${ctx.channelId}>` }] },
        ctx.channelId,
      );
    });

    // ------------------------------------------------------------------ Befehle
    const eventChoices = [...EVENTS.map((e) => ({ name: e, value: e })), { name: 'alle', value: 'all' }];
    const eventsOf = (raw: string): LogEvent[] => (raw === 'all' ? [...EVENTS] : [raw as LogEvent]);
    const updateEvents = (ctx: CommandContext, events: LogEvent[], patch: Partial<EventSetting>) =>
      cog.config.guild(ctx.guildId!).update<Record<string, EventSetting>>('events', (all) => {
        const next = { ...all };
        for (const e of events) next[e] = { ...defaults[e], ...(all[e] ?? {}), ...patch };
        return next;
      });

    cog.group({
      name: 'extmodlog',
      description: 'Erweitertes Server-Log einrichten.',
      aliases: ['serverlog'],
      guildOnly: true,
      permissions: { level: 'admin', member: ['ManageGuild'] },
      run: async (ctx) => {
        const conf = cog.config.guild(ctx.guildId!);
        const lines = EVENTS.map((e) => {
          const s = settingFor(ctx.guildId!, e);
          return `${s.enabled ? '✅' : '❌'} \`${e}\` – ${ctx.t(`names.${e}`)}${s.channel ? ` → <#${s.channel}>` : ''}`;
        });
        await ctx.sendEmbed({
          title: ctx.t('settingsTitle'),
          description: lines.join('\n'),
          fields: [
            { name: ctx.t('defaultChannel'), value: conf.get<string | null>('channel') ? `<#${conf.get('channel')}>` : '–', inline: true },
            { name: ctx.t('ignoredChannels'), value: conf.get<string[]>('ignoredChannels').map((c) => `<#${c}>`).join(' ') || '–', inline: true },
            { name: ctx.t('ignoreBots'), value: conf.get<boolean>('ignoreBots') ? '✅' : '❌', inline: true },
          ],
          footer: ctx.t('settingsFooter', { prefix: ctx.prefix }),
        });
      },
      subcommands: [
        {
          name: 'channel',
          description: 'Standard-Log-Kanal (ohne Angabe: keiner).',
          options: [{ name: 'kanal', description: 'Kanal', type: OptionType.Channel, channel_types: [0, 5] }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('channel', ctx.arg<{ id: string } | undefined>('kanal')?.id ?? null);
            await ctx.tick();
          },
        },
        {
          name: 'toggle',
          description: 'Event an/aus ("alle" für alle Events).',
          options: [
            { name: 'event', description: 'Event', type: OptionType.String, required: true, choices: eventChoices },
            { name: 'aktiv', description: 'an/aus', type: OptionType.Boolean, required: true },
          ],
          examples: ['extmodlog toggle alle an', 'extmodlog toggle commandUsed aus'],
          run: async (ctx) => {
            updateEvents(ctx, eventsOf(ctx.arg<string>('event')), { enabled: ctx.arg<boolean>('aktiv') });
            if (ctx.arg<boolean>('aktiv') && !cog.config.guild(ctx.guildId!).get<string | null>('channel')) {
              return ctx.reply(ctx.t('needChannel', { prefix: ctx.prefix }));
            }
            await ctx.tick();
          },
        },
        {
          name: 'eventchannel',
          description: 'Eigener Kanal für ein Event (ohne Kanal: Standard).',
          options: [
            { name: 'event', description: 'Event', type: OptionType.String, required: true, choices: eventChoices },
            { name: 'kanal', description: 'Kanal', type: OptionType.Channel, channel_types: [0, 5] },
          ],
          run: async (ctx) => {
            updateEvents(ctx, eventsOf(ctx.arg<string>('event')), { channel: ctx.arg<{ id: string } | undefined>('kanal')?.id ?? null });
            await ctx.tick();
          },
        },
        {
          name: 'ignore',
          description: 'Kanal/Kategorie nicht loggen (umschalten).',
          options: [{ name: 'kanal', description: 'Kanal oder Kategorie', type: OptionType.Channel, required: true }],
          run: async (ctx) => {
            const id = ctx.arg<{ id: string }>('kanal').id;
            let now = false;
            cog.config.guild(ctx.guildId!).update<string[]>('ignoredChannels', (l) => {
              now = !l.includes(id);
              return now ? [...l, id] : l.filter((x) => x !== id);
            });
            await ctx.reply(ctx.t(now ? 'ignoredOn' : 'ignoredOff', { channel: `<#${id}>` }));
          },
        },
        {
          name: 'bots',
          description: 'Aktionen von Bots ignorieren.',
          options: [{ name: 'ignorieren', description: 'an/aus', type: OptionType.Boolean, required: true }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('ignoreBots', ctx.arg<boolean>('ignorieren'));
            await ctx.tick();
          },
        },
      ],
    });

  },
});
