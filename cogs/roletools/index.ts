import {
  defineCog,
  embed,
  OptionType,
  pagify,
  parseMessageRef,
  UserError,
  type APIGuildMember,
  type APIRole,
  type Cog,
  type CommandContext,
  type ReactionEvent,
} from '@bot/sdk';

interface ReactionRole {
  channelId: string;
  messageId: string;
  emoji: string;
  roleId: string;
}

/** Emoji-Schlüssel: Custom-Emoji → ID, Unicode → Zeichen ohne Variation-Selector. */
export function emojiKey(e: { id?: string | null; name?: string | null } | string): string {
  if (typeof e === 'string') {
    const custom = /^<a?:\w+:(\d+)>$/.exec(e.trim());
    return custom ? custom[1]! : e.trim().replace(/️/g, '');
  }
  return e.id ? e.id : (e.name ?? '').replace(/️/g, '');
}

/** Für die REST-API: Custom → "name:id", Unicode unverändert. */
function emojiForApi(raw: string): string {
  const custom = /^<a?:(\w+):(\d+)>$/.exec(raw.trim());
  return custom ? `${custom[1]}:${custom[2]}` : raw.trim();
}

export default defineCog({
  setup(cog: Cog) {
    cog.config.registerGuild({ reactions: {} as Record<string, ReactionRole> });
    cog.config.registerRole({ auto: false, sticky: false, exclusive: [] as string[], required: [] as string[] });
    cog.config.registerMember({ stickyRoles: [] as string[] });
    const p = () => cog.platform;

    const botCanManage = (guildId: string, roleId: string): boolean => {
      const role = p().getGuild(guildId)?.roles.get(roleId);
      const bot = p().user?.id;
      return Boolean(role && bot && p().topRolePosition(guildId, bot) > role.position);
    };

    /** Rolle vergeben unter Beachtung von "benötigt" und "exklusiv". Liefert Fehler-Schlüssel oder null. */
    async function giveRole(guildId: string, userId: string, roleId: string, reason: string): Promise<string | null> {
      const member = p().getMember(guildId, userId) ?? (await p().fetchMember(guildId, userId).catch(() => undefined));
      if (!member) return 'noMember';
      if (member.roles.includes(roleId)) return null;
      const rc = cog.config.role(roleId);
      const required = rc.get<string[]>('required');
      if (required.length && !required.some((r) => member.roles.includes(r))) return 'missingRequired';
      if (!botCanManage(guildId, roleId)) return 'botTooLow';
      for (const other of rc.get<string[]>('exclusive')) {
        if (member.roles.includes(other)) await p().removeRole(guildId, userId, other, reason).catch(() => undefined);
      }
      await p().addRole(guildId, userId, roleId, reason);
      return null;
    }

    // ------------------------------------------------------------------ Reaktionsrollen
    const rrKey = (messageId: string, emoji: string) => `${messageId}:${emoji}`;

    cog.on('MESSAGE_REACTION_ADD', async (e: ReactionEvent) => {
      if (!e.guild_id || e.user_id === p().user?.id) return;
      const rr = cog.config.guild(e.guild_id).get<Record<string, ReactionRole>>('reactions')[rrKey(e.message_id, emojiKey(e.emoji))];
      if (!rr) return;
      const problem = await giveRole(e.guild_id, e.user_id, rr.roleId, cog.tg(e.guild_id, 'reactionReason'));
      if (problem === 'missingRequired') {
        await p().removeReaction(e.channel_id, e.message_id, emojiForApi(e.emoji.id ? `<:${e.emoji.name}:${e.emoji.id}>` : (e.emoji.name ?? '')), e.user_id).catch(() => undefined);
        await p().sendDM(e.user_id, cog.tg(e.guild_id, 'dmMissingRequired', { role: p().getGuild(e.guild_id)?.roles.get(rr.roleId)?.name ?? '' })).catch(() => undefined);
      }
    });

    cog.on('MESSAGE_REACTION_REMOVE', async (e: ReactionEvent) => {
      if (!e.guild_id || e.user_id === p().user?.id) return;
      const rr = cog.config.guild(e.guild_id).get<Record<string, ReactionRole>>('reactions')[rrKey(e.message_id, emojiKey(e.emoji))];
      if (!rr) return;
      await p().removeRole(e.guild_id, e.user_id, rr.roleId, cog.tg(e.guild_id, 'reactionReason')).catch(() => undefined);
    });

    cog.on('MESSAGE_DELETE', (d: { id: string; guild_id?: string }) => {
      if (!d.guild_id) return;
      cog.config.guild(d.guild_id).update<Record<string, ReactionRole>>('reactions', (all) =>
        Object.fromEntries(Object.entries(all).filter(([, rr]) => rr.messageId !== d.id)),
      );
    });

    // ------------------------------------------------------------------ Auto- und Sticky-Rollen
    cog.on('GUILD_MEMBER_ADD', async (m: APIGuildMember & { guild_id: string }) => {
      const guildId = m.guild_id;
      const roles = new Set<string>();
      for (const [roleId, rc] of Object.entries(cog.config.allRoles<{ auto: boolean; sticky: boolean }>())) {
        if (rc.auto && p().getGuild(guildId)?.roles.has(roleId)) roles.add(roleId);
      }
      const sticky = cog.config.member(guildId, m.user.id).get<string[]>('stickyRoles');
      for (const r of sticky) if (p().getGuild(guildId)?.roles.has(r) && cog.config.role(r).get<boolean>('sticky')) roles.add(r);
      cog.config.member(guildId, m.user.id).clear('stickyRoles');
      for (const r of roles) {
        if (!botCanManage(guildId, r)) continue;
        await p().addRole(guildId, m.user.id, r, cog.tg(guildId, 'joinReason')).catch((err) => cog.log.debug({ err }, 'Rolle beim Beitritt fehlgeschlagen'));
      }
    });

    cog.on('GUILD_MEMBER_REMOVE', (d: { guild_id: string; user: { id: string } }, previous?: APIGuildMember) => {
      if (!previous?.roles?.length) return;
      const sticky = previous.roles.filter((r) => cog.config.role(r).get<boolean>('sticky'));
      if (sticky.length) cog.config.member(d.guild_id, d.user.id).set('stickyRoles', sticky);
    });

    // ------------------------------------------------------------------ Befehle
    const roleOpt = { name: 'rolle', description: 'Rolle', type: OptionType.Role, required: true } as const;
    const boolOpt = { name: 'aktiv', description: 'an/aus', type: OptionType.Boolean, required: true } as const;
    const ensureManageable = (ctx: CommandContext, role: APIRole) => {
      if (!botCanManage(ctx.guildId!, role.id)) throw new UserError(ctx.t('botTooLow'));
      const actorTop = p().topRolePosition(ctx.guildId!, ctx.author.id);
      if (!ctx.bot.isOwner(ctx.author.id) && actorTop <= role.position) throw new UserError(ctx.t('youTooLow'));
    };

    const roleListCmd = (key: 'exclusive' | 'required', add: boolean) => ({
      name: add ? 'add' : 'remove',
      description: add ? 'Hinzufügen.' : 'Entfernen.',
      options: [roleOpt, { name: 'rollen', description: 'Andere Rollen (Erwähnungen/IDs/Namen in Anführungszeichen)', type: OptionType.Role, required: true, variadic: true }],
      run: async (ctx: CommandContext) => {
        const role = ctx.arg<APIRole>('rolle');
        const others = ctx.arg<APIRole[]>('rollen').filter((r) => r.id !== role.id);
        cog.config.role(role.id).update<string[]>(key, (l) => {
          const set = new Set(l ?? []);
          for (const o of others) add ? set.add(o.id) : set.delete(o.id);
          return [...set];
        });
        // Exklusiv gilt in beide Richtungen
        if (key === 'exclusive') {
          for (const o of others) {
            cog.config.role(o.id).update<string[]>('exclusive', (l) => {
              const set = new Set(l ?? []);
              add ? set.add(role.id) : set.delete(role.id);
              return [...set];
            });
          }
        }
        await ctx.tick();
      },
    });

    cog.group({
      name: 'roletools',
      description: 'Rollen-Werkzeuge: Reaktionsrollen, Auto-, Sticky-, exklusive und benötigte Rollen.',
      aliases: ['rt'],
      guildOnly: true,
      permissions: { level: 'admin', member: ['ManageRoles'], bot: ['ManageRoles'] },
      subcommands: [
        {
          name: 'reaction',
          description: 'Reaktionsrollen.',
          aliases: ['react'],
          subcommands: [
            {
              name: 'add',
              description: 'Verknüpft ein Emoji auf einer Nachricht mit einer Rolle.',
              options: [
                { name: 'nachricht', description: 'Link oder ID der Nachricht', type: OptionType.String, required: true },
                { name: 'emoji', description: 'Emoji', type: OptionType.String, required: true },
                roleOpt,
              ],
              examples: ['roletools reaction add https://chat.nebendahl.eu/channels/1/2/3 🎮 @Gamer'],
              run: async (ctx) => {
                const ref = parseMessageRef(ctx.arg<string>('nachricht'), ctx.channelId);
                if (!ref) throw new UserError(ctx.t('badRef'));
                const role = ctx.arg<APIRole>('rolle');
                ensureManageable(ctx, role);
                const emoji = ctx.arg<string>('emoji');
                try {
                  await p().addReaction(ref.channelId, ref.messageId, emojiForApi(emoji));
                } catch {
                  throw new UserError(ctx.t('reactFailed'));
                }
                const key = rrKey(ref.messageId, emojiKey(emoji));
                cog.config.guild(ctx.guildId!).update<Record<string, ReactionRole>>('reactions', (all) => ({
                  ...all,
                  [key]: { channelId: ref.channelId, messageId: ref.messageId, emoji, roleId: role.id },
                }));
                await ctx.reply(ctx.t('reactionAdded', { emoji, role: role.name }));
              },
            },
            {
              name: 'remove',
              description: 'Entfernt eine Reaktionsrolle.',
              options: [
                { name: 'nachricht', description: 'Link oder ID der Nachricht', type: OptionType.String, required: true },
                { name: 'emoji', description: 'Emoji', type: OptionType.String, required: true },
              ],
              run: async (ctx) => {
                const ref = parseMessageRef(ctx.arg<string>('nachricht'), ctx.channelId);
                if (!ref) throw new UserError(ctx.t('badRef'));
                const key = rrKey(ref.messageId, emojiKey(ctx.arg<string>('emoji')));
                let found = false;
                cog.config.guild(ctx.guildId!).update<Record<string, ReactionRole>>('reactions', (all) => {
                  found = key in all;
                  const { [key]: _gone, ...rest } = all;
                  return rest;
                });
                if (!found) throw new UserError(ctx.t('reactionNotFound'));
                await p().removeReaction(ref.channelId, ref.messageId, emojiForApi(ctx.arg<string>('emoji'))).catch(() => undefined);
                await ctx.tick();
              },
            },
            {
              name: 'list',
              description: 'Alle Reaktionsrollen.',
              run: async (ctx) => {
                const all = Object.values(cog.config.guild(ctx.guildId!).get<Record<string, ReactionRole>>('reactions'));
                if (!all.length) return ctx.reply(ctx.t('noReactions'));
                const lines = all.map((r) => `${r.emoji} → <@&${r.roleId}> – <#${r.channelId}> \`${r.messageId}\``);
                await ctx.paginate(pagify(lines.join('\n'), { pageLength: 1800 }).map((pg) => embed({ title: ctx.t('reactionsTitle'), description: pg })));
              },
            },
          ],
        },
        {
          name: 'auto',
          description: 'Rolle automatisch beim Beitritt vergeben.',
          options: [roleOpt, boolOpt],
          run: async (ctx) => {
            const role = ctx.arg<APIRole>('rolle');
            if (ctx.arg<boolean>('aktiv')) ensureManageable(ctx, role);
            cog.config.role(role.id).set('auto', ctx.arg<boolean>('aktiv'));
            await ctx.tick();
          },
        },
        {
          name: 'sticky',
          description: 'Rolle beim erneuten Beitritt wiederherstellen.',
          options: [roleOpt, boolOpt],
          run: async (ctx) => {
            cog.config.role(ctx.arg<APIRole>('rolle').id).set('sticky', ctx.arg<boolean>('aktiv'));
            await ctx.tick();
          },
        },
        {
          name: 'exclusive',
          description: 'Rollen, die sich gegenseitig ausschließen.',
          subcommands: [roleListCmd('exclusive', true), roleListCmd('exclusive', false)],
        },
        {
          name: 'required',
          description: 'Rollen, von denen man mindestens eine braucht, um diese Rolle zu bekommen.',
          subcommands: [roleListCmd('required', true), roleListCmd('required', false)],
        },
        {
          name: 'info',
          description: 'Einstellungen einer Rolle.',
          permissions: { level: 'mod', member: ['ManageRoles'] },
          options: [roleOpt],
          run: async (ctx) => {
            const role = ctx.arg<APIRole>('rolle');
            const rc = cog.config.role(role.id).all() as { auto: boolean; sticky: boolean; exclusive: string[]; required: string[] };
            const reactions = Object.values(cog.config.guild(ctx.guildId!).get<Record<string, ReactionRole>>('reactions')).filter((r) => r.roleId === role.id);
            await ctx.sendEmbed({
              title: `@${role.name}`,
              fields: [
                { name: ctx.t('fields.auto'), value: rc.auto ? '✅' : '❌', inline: true },
                { name: ctx.t('fields.sticky'), value: rc.sticky ? '✅' : '❌', inline: true },
                { name: ctx.t('fields.exclusive'), value: rc.exclusive.map((r) => `<@&${r}>`).join(' ') || '–' },
                { name: ctx.t('fields.required'), value: rc.required.map((r) => `<@&${r}>`).join(' ') || '–' },
                { name: ctx.t('fields.reactions'), value: reactions.map((r) => `${r.emoji} in <#${r.channelId}>`).join('\n') || '–' },
              ],
            });
          },
        },
      ],
    });

    cog.expose({ giveRole });
  },
});
