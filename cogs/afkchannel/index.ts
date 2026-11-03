import { defineCog, humanizeSeconds, OptionType, PermissionFlags, UserError, type APIVoiceState, type Cog, type CommandContext } from '@bot/sdk';

interface Settings {
  enabled: boolean;
  channel: string | null;
  delay: number;
  moveBack: boolean;
  ignoredRoles: string[];
  ignoredUsers: string[];
  ignoredChannels: string[];
}

/** Soll ein taub geschaltetes Mitglied (irgendwann) verschoben werden? Reine Entscheidung, testbar. */
export function shouldMove(s: Settings, state: Pick<APIVoiceState, 'channel_id' | 'self_deaf' | 'user_id'>, roles: string[], afkChannel: string | null): boolean {
  if (!s.enabled || !afkChannel || !state.channel_id || !state.self_deaf) return false;
  if (state.channel_id === afkChannel) return false;
  if (s.ignoredUsers.includes(state.user_id) || s.ignoredChannels.includes(state.channel_id)) return false;
  return !roles.some((r) => s.ignoredRoles.includes(r));
}

export default defineCog({
  setup(cog: Cog) {
    cog.config.registerGuild({
      enabled: false,
      channel: null,
      delay: 60,
      moveBack: false,
      ignoredRoles: [],
      ignoredUsers: [],
      ignoredChannels: [],
    } satisfies Settings);
    /** Wohin zurück: guild:user → vorheriger Kanal (überlebt Neustarts). */
    cog.config.registerCustom('moved', { from: null as string | null });
    const p = () => cog.platform;
    const timers = new Map<string, NodeJS.Timeout>();
    const settings = (g: string) => cog.config.guild(g).all() as unknown as Settings;
    /** Eigener AFK-Kanal oder der native AFK-Kanal des Servers. */
    const afkChannelOf = (g: string) => settings(g).channel ?? p().getGuild(g)?.afk_channel_id ?? null;

    const cancel = (key: string) => {
      const t = timers.get(key);
      if (t) clearTimeout(t);
      timers.delete(key);
    };

    async function moveToAfk(guildId: string, userId: string): Promise<void> {
      const state = p().getVoiceState(guildId, userId);
      const s = settings(guildId);
      const afk = afkChannelOf(guildId);
      const roles = p().getMember(guildId, userId)?.roles ?? [];
      if (!state || !shouldMove(s, state, roles, afk)) return;
      try {
        await p().moveMember(guildId, userId, afk, cog.tg(guildId, 'auditReason', { time: humanizeSeconds(s.delay) }));
        cog.config.custom('moved', guildId, userId).set('from', state.channel_id);
        cog.log.debug({ guildId, userId }, 'In AFK-Kanal verschoben');
      } catch (err) {
        cog.log.warn({ err, guildId, userId }, 'Verschieben in den AFK-Kanal fehlgeschlagen (Recht „Mitglieder verschieben“?)');
      }
    }

    cog.on('VOICE_STATE_UPDATE', async (state: APIVoiceState, previous?: APIVoiceState) => {
      const guildId = state.guild_id;
      if (!guildId || state.user_id === p().user?.id) return;
      const key = `${guildId}:${state.user_id}`;
      const s = settings(guildId);
      const afk = afkChannelOf(guildId);
      const roles = p().getMember(guildId, state.user_id)?.roles ?? state.member?.roles ?? [];

      // Taub geschaltet (oder in einen anderen Kanal gewechselt, während taub) → Timer starten
      if (shouldMove(s, state, roles, afk)) {
        if (!timers.has(key)) {
          if (s.delay <= 0) return moveToAfk(guildId, state.user_id);
          timers.set(
            key,
            setTimeout(() => {
              timers.delete(key);
              void moveToAfk(guildId, state.user_id);
            }, s.delay * 1000),
          );
        }
        return;
      }
      cancel(key);

      const moved = cog.config.custom('moved', guildId, state.user_id);
      const from = moved.get<string | null>('from');
      if (!state.channel_id) {
        moved.clear(); // Sprachkanal verlassen
        return;
      }
      // Ent-Taubschaltet im AFK-Kanal → optional zurückverschieben
      const undeafened = previous?.self_deaf && !state.self_deaf;
      if (from && undeafened && state.channel_id === afk) {
        moved.clear();
        if (s.moveBack && p().getChannel(from)) {
          await p().moveMember(guildId, state.user_id, from, cog.tg(guildId, 'backReason')).catch((err) => cog.log.debug({ err }, 'Zurückverschieben fehlgeschlagen'));
        }
      } else if (from && state.channel_id !== afk) {
        moved.clear(); // selbst woandershin gewechselt
      }
    });

    cog.onUnload(() => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    });

    // ------------------------------------------------------------------ Befehle
    const toggleList = (ctx: CommandContext, key: 'ignoredRoles' | 'ignoredUsers' | 'ignoredChannels', id: string) => {
      let added = false;
      cog.config.guild(ctx.guildId!).update<string[]>(key, (l) => {
        added = !l.includes(id);
        return added ? [...l, id] : l.filter((x) => x !== id);
      });
      return added;
    };

    cog.group({
      name: 'afkchannel',
      description: 'Automatisches Verschieben taub geschalteter Mitglieder.',
      aliases: ['afk'],
      guildOnly: true,
      permissions: { level: 'admin', member: ['ManageGuild'] },
      run: async (ctx) => {
        const s = settings(ctx.guildId!);
        const afk = afkChannelOf(ctx.guildId!);
        await ctx.sendEmbed({
          title: ctx.t('settingsTitle'),
          fields: [
            { name: ctx.t('f.enabled'), value: s.enabled ? '✅' : '❌', inline: true },
            { name: ctx.t('f.channel'), value: afk ? `<#${afk}>${s.channel ? '' : ` (${ctx.t('native')})`}` : '–', inline: true },
            { name: ctx.t('f.delay'), value: humanizeSeconds(s.delay), inline: true },
            { name: ctx.t('f.moveBack'), value: s.moveBack ? '✅' : '❌', inline: true },
            {
              name: ctx.t('f.ignored'),
              value: [...s.ignoredRoles.map((r) => `<@&${r}>`), ...s.ignoredUsers.map((u) => `<@${u}>`), ...s.ignoredChannels.map((c) => `<#${c}>`)].join(' ') || '–',
            },
          ],
        });
      },
      subcommands: [
        {
          name: 'set',
          description: 'AFK-Kanal festlegen.',
          permissions: { level: 'admin', member: ['ManageGuild'], bot: ['MoveMembers'] },
          options: [{ name: 'kanal', description: 'Sprachkanal', type: OptionType.Channel, required: true, channel_types: [2] }],
          run: async (ctx) => {
            const ch = ctx.arg<{ id: string }>('kanal');
            cog.config.guild(ctx.guildId!).setAll({ channel: ch.id, enabled: true });
            const canMove = await ctx.bot.platform.botCan(ctx.guildId!, ch.id, PermissionFlags.MoveMembers);
            await ctx.reply(ctx.t('set', { channel: `<#${ch.id}>`, delay: humanizeSeconds(cog.config.guild(ctx.guildId!).get<number>('delay')) }) + (canMove ? '' : `\n⚠️ ${ctx.t('noMovePerm')}`));
          },
        },
        {
          name: 'toggle',
          description: 'An/aus.',
          options: [{ name: 'aktiv', description: 'an/aus', type: OptionType.Boolean, required: true }],
          run: async (ctx) => {
            if (ctx.arg<boolean>('aktiv') && !afkChannelOf(ctx.guildId!)) throw new UserError(ctx.t('noChannel', { prefix: ctx.prefix }));
            cog.config.guild(ctx.guildId!).set('enabled', ctx.arg<boolean>('aktiv'));
            await ctx.tick();
          },
        },
        {
          name: 'delay',
          description: 'Wartezeit, bevor verschoben wird (z. B. 60 Sekunden, 0 = sofort).',
          options: [{ name: 'sekunden', description: 'Sekunden', type: OptionType.Integer, required: true, min_value: 0, max_value: 3600 }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('delay', ctx.arg<number>('sekunden'));
            await ctx.tick();
          },
        },
        {
          name: 'moveback',
          description: 'Beim Ent-Taubschalten in den vorherigen Kanal zurückverschieben.',
          options: [{ name: 'aktiv', description: 'an/aus', type: OptionType.Boolean, required: true }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('moveBack', ctx.arg<boolean>('aktiv'));
            await ctx.tick();
          },
        },
        {
          name: 'ignore',
          description: 'Rolle, Mitglied oder Sprachkanal ausnehmen (umschalten).',
          options: [{ name: 'ziel', description: '@rolle, @user oder #kanal', type: OptionType.String, required: true }],
          run: async (ctx) => {
            const raw = ctx.arg<string>('ziel');
            const g = ctx.guild;
            const role = /^<@&(\d+)>$/.exec(raw)?.[1] ?? (g?.roles.has(raw) ? raw : undefined);
            const channel = /^<#(\d+)>$/.exec(raw)?.[1] ?? (g?.channels.has(raw) ? raw : undefined);
            const user = /^<@!?(\d+)>$/.exec(raw)?.[1] ?? (/^\d{15,21}$/.test(raw) && !role && !channel ? raw : undefined);
            let added: boolean;
            if (role) added = toggleList(ctx, 'ignoredRoles', role);
            else if (channel) added = toggleList(ctx, 'ignoredChannels', channel);
            else if (user) added = toggleList(ctx, 'ignoredUsers', user);
            else throw new UserError(ctx.t('badTarget'));
            await ctx.reply(ctx.t(added ? 'ignoreOn' : 'ignoreOff'));
          },
        },
      ],
    });
  },
});
