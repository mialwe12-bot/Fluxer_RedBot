import { defineCog, escapeRegex, OptionType, UserError, type APIMessage, type Cog, type CommandContext } from '@bot/sdk';
import type { ModlogApi } from '../modlog/index.js';

/**
 * Erkennt Einladungslinks. Annahme für Fluxer: fluxer.gg/<code> und <instanz>/invite/<code>
 * (zusätzlich discord.gg / discord.com/invite, weil diese häufig gespammt werden).
 */
export function inviteRegex(instanceHost: string): RegExp {
  const host = escapeRegex(instanceHost.replace(/^www\./, ''));
  return new RegExp(
    `(?:https?:\\/\\/)?(?:www\\.)?(?:fluxer\\.gg|${host}\\/invite|web\\.fluxer\\.app\\/invite|discord(?:app)?\\.com\\/invite|discord\\.gg)\\/([\\w-]{2,32})`,
    'gi',
  );
}

export function extractInviteCodes(text: string, instanceHost: string): string[] {
  return [...text.matchAll(inviteRegex(instanceHost))].map((m) => m[1]!);
}

interface InviteInfo {
  guildId: string | null;
  at: number;
}

export default defineCog({
  setup(cog: Cog) {
    cog.config.registerGuild({
      enabled: false,
      mode: 'all' as 'all' | 'list',
      allowOwnServer: true,
      allowed: [] as string[],
      blocked: [] as string[],
      notify: true,
    });
    const p = () => cog.platform;
    const modlog = () => cog.bot.cogApi<ModlogApi>('modlog');
    const host = new URL(cog.bot.env.baseUrl).host;
    const cache = new Map<string, InviteInfo>();

    const resolve = async (code: string): Promise<string | null> => {
      const hit = cache.get(code);
      if (hit && Date.now() - hit.at < 3600_000) return hit.guildId;
      const info = await p().fetchInvite(code);
      const guildId = info?.guild?.id ?? null;
      cache.set(code, { guildId, at: Date.now() });
      return guildId;
    };

    /** true = Einladung ist auf diesem Server nicht erlaubt. */
    async function isBlocked(guildId: string, code: string): Promise<boolean> {
      const conf = cog.config.guild(guildId);
      const allowed = conf.get<string[]>('allowed');
      const blocked = conf.get<string[]>('blocked');
      const lowered = code.toLowerCase();
      if (allowed.includes(lowered)) return false;
      if (blocked.includes(lowered)) return true;
      const target = await resolve(code);
      if (target && conf.get<boolean>('allowOwnServer') && target === guildId) return false;
      if (target && allowed.includes(target)) return false;
      if (target && blocked.includes(target)) return true;
      return conf.get<'all' | 'list'>('mode') === 'all';
    }

    async function check(m: APIMessage): Promise<void> {
      const guildId = m.guild_id;
      if (!guildId || !m.author || (m.author as { bot?: boolean }).bot) return;
      if (!cog.config.guild(guildId).get<boolean>('enabled')) return;
      const codes = extractInviteCodes(m.content ?? '', host);
      if (!codes.length) return;
      if (await cog.bot.isImmune(guildId, m.author.id)) return;
      for (const code of codes) {
        if (!(await isBlocked(guildId, code))) continue;
        await p().deleteMessage(m.channel_id, m.id, cog.tg(guildId, 'auditReason')).catch(() => undefined);
        await modlog()?.createCase({ guildId, action: 'inviteblock', targetId: m.author.id, moderatorId: p().user?.id ?? null, reason: cog.tg(guildId, 'caseReason', { code }) });
        if (cog.config.guild(guildId).get<boolean>('notify')) {
          const note = await cog.bot.send(m.channel_id, { content: cog.tg(guildId, 'notice', { user: `<@${m.author.id}>` }), allowed_mentions: { users: [m.author.id] } }).catch(() => undefined);
          if (note) setTimeout(() => void p().deleteMessage(note.channel_id, note.id).catch(() => undefined), 10_000).unref();
        }
        return;
      }
    }

    cog.on('MESSAGE_CREATE', check);
    cog.on('MESSAGE_UPDATE', (m: APIMessage) => {
      if (typeof m.content === 'string' && m.author) return check(m);
    });

    // ------------------------------------------------------------------ Befehle
    const entryOpt = { name: 'eintraege', description: 'Einladungscodes/-links oder Server-IDs', type: OptionType.String, required: true, variadic: true } as const;
    const normalize = (raw: string): string => {
      const code = extractInviteCodes(raw, host)[0];
      return (code ?? raw).toLowerCase().trim();
    };
    const editList = (ctx: CommandContext, key: 'allowed' | 'blocked', add: boolean) => {
      const items = ctx.arg<string[]>('eintraege').map(normalize).filter(Boolean);
      cog.config.guild(ctx.guildId!).update<string[]>(key, (list) => {
        const set = new Set(list ?? []);
        for (const i of items) add ? set.add(i) : set.delete(i);
        return [...set];
      });
      return items.length;
    };

    cog.group({
      name: 'inviteblock',
      description: 'Einladungslinks zu fremden Servern sperren.',
      aliases: ['inviteblocklist'],
      guildOnly: true,
      permissions: { level: 'admin', member: ['ManageGuild'] },
      run: async (ctx) => {
        const c = cog.config.guild(ctx.guildId!).all();
        await ctx.sendEmbed({
          title: ctx.t('title'),
          fields: [
            { name: ctx.t('fields.status'), value: c.enabled ? ctx.t('common.on') : ctx.t('common.off'), inline: true },
            { name: ctx.t('fields.mode'), value: ctx.t(`modes.${c.mode}`), inline: true },
            { name: ctx.t('fields.own'), value: c.allowOwnServer ? '✅' : '❌', inline: true },
            { name: ctx.t('fields.allowed'), value: (c.allowed as string[]).map((x) => `\`${x}\``).join(', ') || '–' },
            { name: ctx.t('fields.blocked'), value: (c.blocked as string[]).map((x) => `\`${x}\``).join(', ') || '–' },
          ],
        });
      },
      subcommands: [
        {
          name: 'toggle',
          description: 'Einladungssperre an/aus.',
          permissions: { level: 'admin', member: ['ManageGuild'], bot: ['ManageMessages'] },
          options: [{ name: 'aktiv', description: 'an/aus', type: OptionType.Boolean, required: true }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('enabled', ctx.arg<boolean>('aktiv'));
            await ctx.tick();
          },
        },
        {
          name: 'mode',
          description: '"alle" = alles sperren außer Erlaubnisliste, "liste" = nur Sperrliste.',
          options: [
            {
              name: 'modus',
              description: 'alle oder liste',
              type: OptionType.String,
              required: true,
              choices: [
                { name: 'alle', value: 'all' },
                { name: 'liste', value: 'list' },
              ],
            },
          ],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('mode', ctx.arg<string>('modus'));
            await ctx.reply(ctx.t('modeSet', { mode: ctx.t(`modes.${ctx.arg<string>('modus')}`) }));
          },
        },
        {
          name: 'allow',
          description: 'Erlaubnisliste bearbeiten.',
          subcommands: [
            { name: 'add', description: 'Erlauben.', options: [entryOpt], run: async (ctx) => ctx.reply(ctx.t('listChanged', { count: editList(ctx, 'allowed', true) })) },
            { name: 'remove', description: 'Nicht mehr erlauben.', options: [entryOpt], run: async (ctx) => ctx.reply(ctx.t('listChanged', { count: editList(ctx, 'allowed', false) })) },
          ],
        },
        {
          name: 'block',
          description: 'Sperrliste bearbeiten.',
          subcommands: [
            { name: 'add', description: 'Sperren.', options: [entryOpt], run: async (ctx) => ctx.reply(ctx.t('listChanged', { count: editList(ctx, 'blocked', true) })) },
            { name: 'remove', description: 'Nicht mehr sperren.', options: [entryOpt], run: async (ctx) => ctx.reply(ctx.t('listChanged', { count: editList(ctx, 'blocked', false) })) },
          ],
        },
        {
          name: 'ownserver',
          description: 'Einladungen zu diesem Server erlauben.',
          options: [{ name: 'aktiv', description: 'an/aus', type: OptionType.Boolean, required: true }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('allowOwnServer', ctx.arg<boolean>('aktiv'));
            await ctx.tick();
          },
        },
        {
          name: 'notify',
          description: 'Kurzen Hinweis im Kanal posten, wenn gelöscht wurde.',
          options: [{ name: 'aktiv', description: 'an/aus', type: OptionType.Boolean, required: true }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('notify', ctx.arg<boolean>('aktiv'));
            await ctx.tick();
          },
        },
        {
          name: 'check',
          description: 'Prüft, ob eine Einladung hier gesperrt wäre.',
          options: [{ name: 'einladung', description: 'Link oder Code', type: OptionType.String, required: true }],
          run: async (ctx) => {
            const code = extractInviteCodes(ctx.arg<string>('einladung'), host)[0] ?? ctx.arg<string>('einladung');
            if (!code) throw new UserError(ctx.t('noCode'));
            await ctx.reply(ctx.t((await isBlocked(ctx.guildId!, code)) ? 'wouldBlock' : 'wouldAllow', { code }));
          },
        },
      ],
    });
  },
});
