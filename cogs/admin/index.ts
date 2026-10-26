import {
  defineCog,
  OptionType,
  UserError,
  type APIRole,
  type Cog,
  type CommandContext,
  type ResolvedUser,
} from '@bot/sdk';

/** "#ff8800", "ff8800", "0xff8800" oder ein deutscher/englischer Farbname → Zahl. */
export function parseColor(raw: string): number | undefined {
  const names: Record<string, number> = {
    rot: 0xe74c3c, red: 0xe74c3c, grün: 0x2ecc71, gruen: 0x2ecc71, green: 0x2ecc71, blau: 0x3498db, blue: 0x3498db,
    gelb: 0xf1c40f, yellow: 0xf1c40f, orange: 0xe67e22, lila: 0x9b59b6, violett: 0x9b59b6, purple: 0x9b59b6,
    pink: 0xff69b4, weiß: 0xffffff, weiss: 0xffffff, white: 0xffffff, schwarz: 0x010101, black: 0x010101,
    grau: 0x95a5a6, grey: 0x95a5a6, gray: 0x95a5a6, türkis: 0x1abc9c, tuerkis: 0x1abc9c, keine: 0, none: 0,
  };
  const t = raw.trim().toLowerCase();
  if (t in names) return names[t];
  const hex = /^(?:#|0x)?([0-9a-f]{6}|[0-9a-f]{3})$/.exec(t);
  if (!hex) return undefined;
  const h = hex[1]!.length === 3 ? [...hex[1]!].map((c) => c + c).join('') : hex[1]!;
  return parseInt(h, 16);
}

export default defineCog({
  setup(cog: Cog) {
    cog.config.registerGuild({ announceChannel: null as string | null, announceIgnore: false, selfroles: [] as string[] });
    cog.config.registerGlobal({ serverLocked: false });
    const p = () => cog.platform;

    // ------------------------------------------------------------------ Hilfen
    const canEditRole = (ctx: CommandContext, role: APIRole) => {
      const bot = p().user?.id ?? '';
      if (role.id === ctx.guildId) throw new UserError(ctx.t('everyone'));
      if (p().topRolePosition(ctx.guildId!, bot) <= role.position) throw new UserError(ctx.t('botTooLow', { role: role.name }));
      if (!ctx.bot.isOwner(ctx.author.id) && p().topRolePosition(ctx.guildId!, ctx.author.id) <= role.position) {
        throw new UserError(ctx.t('youTooLow', { role: role.name }));
      }
    };

    const roleOpt = { name: 'rolle', description: 'Rolle', type: OptionType.Role, required: true } as const;
    const userOpt = { name: 'user', description: 'Mitglied (Standard: du)', type: OptionType.User } as const;
    const rolePerms = { level: 'admin', member: ['ManageRoles'], bot: ['ManageRoles'] } as const;

    cog.command({
      name: 'addrole',
      description: 'Gibt einem Mitglied eine Rolle.',
      guildOnly: true,
      permissions: rolePerms,
      options: [roleOpt, userOpt],
      run: async (ctx) => {
        const role = ctx.arg<APIRole>('rolle');
        const user = ctx.arg<ResolvedUser | undefined>('user') ?? { id: ctx.author.id };
        canEditRole(ctx, role);
        await p().addRole(ctx.guildId!, user.id, role.id, `addrole durch ${ctx.author.username}`);
        await ctx.reply(ctx.t('roleAdded', { role: role.name, user: `<@${user.id}>` }));
      },
    });

    cog.command({
      name: 'removerole',
      description: 'Nimmt einem Mitglied eine Rolle.',
      guildOnly: true,
      permissions: rolePerms,
      options: [roleOpt, userOpt],
      run: async (ctx) => {
        const role = ctx.arg<APIRole>('rolle');
        const user = ctx.arg<ResolvedUser | undefined>('user') ?? { id: ctx.author.id };
        canEditRole(ctx, role);
        await p().removeRole(ctx.guildId!, user.id, role.id, `removerole durch ${ctx.author.username}`);
        await ctx.reply(ctx.t('roleRemoved', { role: role.name, user: `<@${user.id}>` }));
      },
    });

    cog.group({
      name: 'editrole',
      description: 'Rollen bearbeiten.',
      guildOnly: true,
      permissions: rolePerms,
      subcommands: [
        {
          name: 'color',
          description: 'Farbe einer Rolle ändern (#hex oder Name).',
          aliases: ['colour', 'farbe'],
          options: [roleOpt, { name: 'farbe', description: 'z. B. #ff8800 oder rot', type: OptionType.String, required: true }],
          run: async (ctx) => {
            const role = ctx.arg<APIRole>('rolle');
            const color = parseColor(ctx.arg<string>('farbe'));
            if (color === undefined) throw new UserError(ctx.t('badColor'));
            canEditRole(ctx, role);
            await p().editRole(ctx.guildId!, role.id, { color });
            await ctx.reply(ctx.t('colorSet', { role: role.name, color: `#${color.toString(16).padStart(6, '0')}` }));
          },
        },
        {
          name: 'name',
          description: 'Rolle umbenennen.',
          options: [roleOpt, { name: 'name', description: 'Neuer Name', type: OptionType.String, required: true, rest: true, max_length: 100 }],
          run: async (ctx) => {
            const role = ctx.arg<APIRole>('rolle');
            canEditRole(ctx, role);
            await p().editRole(ctx.guildId!, role.id, { name: ctx.arg<string>('name') });
            await ctx.reply(ctx.t('renamed', { old: role.name, name: ctx.arg<string>('name') }));
          },
        },
      ],
    });

    // ------------------------------------------------------------------ Selbst wählbare Rollen
    cog.group({
      name: 'selfrole',
      description: 'Selbst wählbare Rollen.',
      guildOnly: true,
      options: [{ name: 'rolle', description: 'Rolle', type: OptionType.Role, required: true }],
      run: async (ctx) => {
        const role = ctx.arg<APIRole>('rolle');
        if (!cog.config.guild(ctx.guildId!).get<string[]>('selfroles').includes(role.id)) throw new UserError(ctx.t('notSelfrole', { role: role.name }));
        await p().addRole(ctx.guildId!, ctx.author.id, role.id, 'selfrole');
        await ctx.reply(ctx.t('selfroleAdded', { role: role.name }));
      },
      subcommands: [
        {
          name: 'remove',
          description: 'Entfernt eine selbst gewählte Rolle von dir.',
          options: [roleOpt],
          run: async (ctx) => {
            const role = ctx.arg<APIRole>('rolle');
            if (!cog.config.guild(ctx.guildId!).get<string[]>('selfroles').includes(role.id)) throw new UserError(ctx.t('notSelfrole', { role: role.name }));
            await p().removeRole(ctx.guildId!, ctx.author.id, role.id, 'selfrole');
            await ctx.reply(ctx.t('selfroleRemoved', { role: role.name }));
          },
        },
        {
          name: 'list',
          description: 'Alle selbst wählbaren Rollen.',
          run: async (ctx) => {
            const roles = cog.config.guild(ctx.guildId!).get<string[]>('selfroles').map((id) => ctx.guild?.roles.get(id)?.name).filter(Boolean);
            await ctx.reply(roles.length ? `${ctx.t('selfroleList')}\n${roles.map((r) => `• ${r}`).join('\n')}` : ctx.t('noSelfroles'));
          },
        },
      ],
    });

    cog.group({
      name: 'selfroleset',
      description: 'Selbst wählbare Rollen festlegen.',
      guildOnly: true,
      permissions: rolePerms,
      subcommands: [
        {
          name: 'add',
          description: 'Rollen selbst wählbar machen.',
          options: [{ name: 'rollen', description: 'Rollen', type: OptionType.Role, required: true, variadic: true }],
          run: async (ctx) => {
            const roles = ctx.arg<APIRole[]>('rollen');
            for (const r of roles) canEditRole(ctx, r);
            cog.config.guild(ctx.guildId!).update<string[]>('selfroles', (l) => [...new Set([...l, ...roles.map((r) => r.id)])]);
            await ctx.tick();
          },
        },
        {
          name: 'remove',
          description: 'Rollen nicht mehr selbst wählbar machen.',
          options: [{ name: 'rollen', description: 'Rollen', type: OptionType.Role, required: true, variadic: true }],
          run: async (ctx) => {
            const ids = ctx.arg<APIRole[]>('rollen').map((r) => r.id);
            cog.config.guild(ctx.guildId!).update<string[]>('selfroles', (l) => l.filter((id) => !ids.includes(id)));
            await ctx.tick();
          },
        },
      ],
    });

    // ------------------------------------------------------------------ Ankündigungen
    cog.command({
      name: 'announce',
      description: 'Schickt eine Ankündigung an alle Server (in deren Ankündigungskanal).',
      permissions: { level: 'owner' },
      options: [{ name: 'nachricht', description: 'Text', type: OptionType.String, required: true, rest: true, max_length: 1900 }],
      run: async (ctx) => {
        const text = ctx.arg<string>('nachricht');
        if (!(await ctx.confirm(ctx.t('announceConfirm', { count: p().guilds.size })))) return ctx.reply(ctx.t('common.cancelled'));
        let sent = 0;
        let skipped = 0;
        for (const g of p().guilds.values()) {
          const conf = cog.config.guild(g.id);
          const channel = conf.get<string | null>('announceChannel');
          if (conf.get<boolean>('announceIgnore') || !channel) {
            skipped++;
            continue;
          }
          try {
            await cog.bot.send(channel, { content: text, allowed_mentions: { parse: [] } }, g.id);
            sent++;
          } catch {
            skipped++;
          }
          await new Promise((r) => setTimeout(r, 500)); // schonend für Rate-Limits
        }
        await ctx.reply(ctx.t('announced', { sent, skipped }));
      },
    });

    cog.group({
      name: 'announceset',
      description: 'Ankündigungen für diesen Server.',
      guildOnly: true,
      permissions: { level: 'admin', member: ['ManageGuild'] },
      subcommands: [
        {
          name: 'channel',
          description: 'Kanal für Bot-Ankündigungen (ohne Angabe: keiner).',
          options: [{ name: 'kanal', description: 'Kanal', type: OptionType.Channel, channel_types: [0, 5] }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('announceChannel', ctx.arg<{ id: string } | undefined>('kanal')?.id ?? null);
            await ctx.tick();
          },
        },
        {
          name: 'ignore',
          description: 'Ankündigungen für diesen Server ignorieren (umschalten).',
          run: async (ctx) => {
            const now = !cog.config.guild(ctx.guildId!).get<boolean>('announceIgnore');
            cog.config.guild(ctx.guildId!).set('announceIgnore', now);
            await ctx.reply(ctx.t(now ? 'ignoreOn' : 'ignoreOff'));
          },
        },
      ],
    });

    // ------------------------------------------------------------------ Serversperre
    const known = new Set<string>();
    cog.on('READY', (d: { guilds?: Array<{ id: string }> }) => {
      for (const g of d.guilds ?? []) known.add(g.id);
    });
    cog.onReady(() => {
      for (const id of p().guilds.keys()) known.add(id);
    });
    cog.on('GUILD_CREATE', async (g: { id: string; name?: string; properties?: { name?: string } }) => {
      if (known.has(g.id)) return;
      known.add(g.id);
      if (!cog.config.global().get<boolean>('serverLocked')) return;
      cog.log.info({ guild: g.id, name: g.name ?? g.properties?.name }, 'Serversperre aktiv – verlasse neuen Server');
      await p().leaveGuild(g.id).catch((err) => cog.log.warn({ err }, 'Server konnte nicht verlassen werden'));
    });

    cog.command({
      name: 'serverlock',
      description: 'Neue Server sofort wieder verlassen (umschalten).',
      permissions: { level: 'owner' },
      run: async (ctx) => {
        const now = !cog.config.global().get<boolean>('serverLocked');
        cog.config.global().set('serverLocked', now);
        await ctx.reply(ctx.t(now ? 'lockOn' : 'lockOff'));
      },
    });
  },
});
