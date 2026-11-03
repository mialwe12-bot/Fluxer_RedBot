import { defineCog, embed, formatNumber, OptionType, UserError, type APIGuildMember, type Cog, type CommandContext, type CommandDefinition } from '@bot/sdk';

type Kind = 'join' | 'leave' | 'ban';
const KINDS: Kind[] = ['join', 'leave', 'ban'];

const DEFAULTS: Record<Kind, string[]> = {
  join: ['👋 Willkommen {member} auf **{server}**! Du bist Mitglied Nr. {count}.'],
  leave: ['👋 **{member.name}** hat den Server verlassen.'],
  ban: ['🔨 **{member.name}** wurde gebannt.'],
};

/** Platzhalter: {member}, {member.name}, {member.id}, {server}, {count}. */
export function renderWelcome(template: string, v: { id: string; name: string; server: string; count: number }): string {
  return template
    .replace(/\{member\.name\}/g, v.name)
    .replace(/\{member\.id\}/g, v.id)
    .replace(/\{member\}/g, `<@${v.id}>`)
    .replace(/\{server\}/g, v.server)
    .replace(/\{count\}/g, formatNumber(v.count));
}

export default defineCog({
  setup(cog: Cog) {
    cog.config.registerGuild({
      enabled: false,
      channel: null as string | null,
      events: { join: true, leave: true, ban: false } as Record<Kind, boolean>,
      messages: DEFAULTS,
      dm: null as string | null,
      embed: false,
    });
    const p = () => cog.platform;

    async function post(guildId: string, kind: Kind, user: { id: string; username: string }, force = false, channelOverride?: string): Promise<boolean> {
      const conf = cog.config.guild(guildId);
      if (!force && (!conf.get<boolean>('enabled') || !conf.get<Record<Kind, boolean>>('events')[kind])) return false;
      const channel = channelOverride ?? conf.get<string | null>('channel');
      if (!channel) return false;
      const list = conf.get<Record<Kind, string[]>>('messages')[kind] ?? DEFAULTS[kind];
      if (!list.length) return false;
      const g = p().getGuild(guildId);
      const text = renderWelcome(list[Math.floor(Math.random() * list.length)]!, {
        id: user.id,
        name: user.username,
        server: g?.name ?? '',
        count: g?.member_count || g?.members.size || 0,
      });
      const mentions = { allowed_mentions: { users: kind === 'join' ? [user.id] : [] } };
      const payload = conf.get<boolean>('embed')
        ? await cog.bot.adaptPayload({ embeds: [embed({ description: text, color: kind === 'join' ? 0x2ecc71 : 0x95a5a6 })], ...mentions }, guildId, channel)
        : { content: text, ...mentions };
      await cog.bot.send(channel, payload, guildId);
      return true;
    }

    cog.on('GUILD_MEMBER_ADD', async (m: APIGuildMember & { guild_id: string }) => {
      if ((m.user as { bot?: boolean }).bot) return;
      await post(m.guild_id, 'join', m.user as { id: string; username: string }).catch((err) => cog.log.debug({ err }, 'Begrüßung fehlgeschlagen'));
      const dm = cog.config.guild(m.guild_id).get<string | null>('dm');
      if (dm && cog.config.guild(m.guild_id).get<boolean>('enabled')) {
        const g = p().getGuild(m.guild_id);
        await p()
          .sendDM(m.user.id, renderWelcome(dm, { id: m.user.id, name: m.user.username, server: g?.name ?? '', count: g?.member_count ?? 0 }))
          .catch(() => undefined);
      }
    });
    cog.on('GUILD_MEMBER_REMOVE', (d: { guild_id: string; user: { id: string; username: string; bot?: boolean } }) => {
      if (d.user.bot) return;
      return post(d.guild_id, 'leave', d.user).catch(() => undefined);
    });
    cog.on('GUILD_BAN_ADD', (d: { guild_id: string; user: { id: string; username: string } }) => post(d.guild_id, 'ban', d.user).catch(() => undefined));

    // ------------------------------------------------------------------ Befehle
    const kindOpt = { name: 'art', description: 'join, leave oder ban', type: OptionType.String, required: true, choices: KINDS.map((k) => ({ name: k, value: k })) } as const;
    const edit = (ctx: CommandContext, fn: (list: string[]) => string[]) => {
      const kind = ctx.arg<Kind>('art');
      cog.config.guild(ctx.guildId!).update<Record<Kind, string[]>>('messages', (all) => ({ ...DEFAULTS, ...all, [kind]: fn(all?.[kind] ?? DEFAULTS[kind]) }));
    };

    const subs: CommandDefinition[] = [
      {
        name: 'toggle',
        description: 'Begrüßungen an/aus.',
        options: [{ name: 'aktiv', description: 'an/aus', type: OptionType.Boolean, required: true }],
        run: async (ctx) => {
          cog.config.guild(ctx.guildId!).set('enabled', ctx.arg<boolean>('aktiv'));
          if (ctx.arg<boolean>('aktiv') && !cog.config.guild(ctx.guildId!).get('channel')) return ctx.reply(ctx.t('needChannel', { prefix: ctx.prefix }));
          await ctx.tick();
        },
      },
      {
        name: 'channel',
        description: 'Kanal für Begrüßungen.',
        options: [{ name: 'kanal', description: 'Kanal', type: OptionType.Channel, required: true, channel_types: [0, 5] }],
        run: async (ctx) => {
          cog.config.guild(ctx.guildId!).set('channel', ctx.arg<{ id: string }>('kanal').id);
          await ctx.tick();
        },
      },
      {
        name: 'event',
        description: 'Einzelne Ereignisse an/aus (join, leave, ban).',
        options: [kindOpt, { name: 'aktiv', description: 'an/aus', type: OptionType.Boolean, required: true }],
        run: async (ctx) => {
          cog.config.guild(ctx.guildId!).update<Record<Kind, boolean>>('events', (e) => ({ ...e, [ctx.arg<Kind>('art')]: ctx.arg<boolean>('aktiv') }));
          await ctx.tick();
        },
      },
      {
        name: 'add',
        description: 'Text hinzufügen ({member}, {member.name}, {server}, {count}); bei mehreren wird zufällig gewählt.',
        options: [kindOpt, { name: 'text', description: 'Text', type: OptionType.String, required: true, rest: true, max_length: 1500 }],
        examples: ['welcomeset add join Hallo {member}, schön dass du da bist! 🎉'],
        run: async (ctx) => {
          edit(ctx, (l) => [...l, ctx.arg<string>('text')]);
          await ctx.tick();
        },
      },
      {
        name: 'remove',
        description: 'Text nach Nummer entfernen (siehe list).',
        options: [kindOpt, { name: 'nummer', description: 'Nummer', type: OptionType.Integer, required: true, min_value: 1 }],
        run: async (ctx) => {
          let removed = false;
          edit(ctx, (l) => {
            const i = ctx.arg<number>('nummer') - 1;
            removed = i < l.length;
            return l.filter((_, idx) => idx !== i);
          });
          if (!removed) throw new UserError(ctx.t('noSuchNumber'));
          await ctx.tick();
        },
      },
      {
        name: 'list',
        description: 'Alle Texte einer Art.',
        options: [kindOpt],
        run: async (ctx) => {
          const list = cog.config.guild(ctx.guildId!).get<Record<Kind, string[]>>('messages')[ctx.arg<Kind>('art')] ?? [];
          await ctx.sendEmbed({ title: ctx.t(`titles.${ctx.arg<Kind>('art')}`), description: list.map((t, i) => `**${i + 1}.** ${t}`).join('\n').slice(0, 4000) || '–' });
        },
      },
      {
        name: 'dm',
        description: 'Neue Mitglieder zusätzlich per DM begrüßen ("aus" = nein).',
        options: [{ name: 'text', description: 'DM-Text oder "aus"', type: OptionType.String, required: true, rest: true, max_length: 1500 }],
        run: async (ctx) => {
          const t = ctx.arg<string>('text');
          cog.config.guild(ctx.guildId!).set('dm', ['aus', 'off'].includes(t.toLowerCase()) ? null : t);
          await ctx.tick();
        },
      },
      {
        name: 'embed',
        description: 'Als Embed statt als Text senden.',
        options: [{ name: 'aktiv', description: 'an/aus', type: OptionType.Boolean, required: true }],
        run: async (ctx) => {
          cog.config.guild(ctx.guildId!).set('embed', ctx.arg<boolean>('aktiv'));
          await ctx.tick();
        },
      },
      {
        name: 'test',
        description: 'Probe-Nachricht mit dir als Mitglied (in diesem Kanal).',
        options: [kindOpt],
        run: async (ctx) => {
          await post(ctx.guildId!, ctx.arg<Kind>('art'), ctx.author, true, ctx.channelId);
        },
      },
    ];

    cog.group({
      name: 'welcomeset',
      description: 'Begrüßungen einrichten.',
      aliases: ['welcome'],
      guildOnly: true,
      permissions: { level: 'admin', member: ['ManageGuild'] },
      run: async (ctx) => {
        const c = cog.config.guild(ctx.guildId!).all() as { enabled: boolean; channel: string | null; events: Record<Kind, boolean>; dm: string | null; embed: boolean };
        await ctx.sendEmbed({
          title: ctx.t('settingsTitle'),
          fields: [
            { name: ctx.t('f.enabled'), value: c.enabled ? '✅' : '❌', inline: true },
            { name: ctx.t('f.channel'), value: c.channel ? `<#${c.channel}>` : '–', inline: true },
            { name: ctx.t('f.events'), value: KINDS.map((k) => `${c.events[k] ? '✅' : '❌'} ${k}`).join('  '), inline: true },
            { name: ctx.t('f.dm'), value: c.dm ?? '–' },
            { name: ctx.t('f.embed'), value: c.embed ? '✅' : '❌', inline: true },
          ],
        });
      },
      subcommands: subs,
    });
  },
});
