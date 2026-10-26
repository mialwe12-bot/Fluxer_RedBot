import os from 'node:os';
import { CogError } from '../cogs/loader.js';
import type { CommandContext } from '../commands/context.js';
import type { ResolvedMentionable, ResolvedUser } from '../commands/parser.js';
import { OptionType, type CommandDefinition } from '../commands/types.js';
import { CommandError, UserError } from '../commands/errors.js';
import type { APIRole, BotStatus } from '../platform/types.js';
import type { CogDefinition, CogManifest } from '../sdk/index.js';
import { EXIT_RESTART, EXIT_SHUTDOWN } from '../bot.js';
import { Colors, embed } from '../utils/embeds.js';
import { codeBlock, formatDateTime, humanizeSeconds, inlineCode, pagify } from '../utils/format.js';

export const CORE_MANIFEST: CogManifest = {
  name: 'core',
  version: '1.0.0',
  author: 'fluxer-redbot',
  description: 'Kernbefehle: Cogs verwalten, Hilfe, Einstellungen, Owner.',
  displayName: 'Core',
};

const STATUS_CHOICES = [
  { name: 'online', value: 'online' },
  { name: 'abwesend', value: 'idle' },
  { name: 'dnd', value: 'dnd' },
  { name: 'unsichtbar', value: 'invisible' },
];

function cogErrorText(ctx: CommandContext, err: unknown): string {
  if (err instanceof CogError) return ctx.t(err.key, err.vars);
  return (err as Error)?.message ?? String(err);
}

/** Lädt/entlädt mehrere Cogs und meldet das Ergebnis gesammelt. */
async function batch(
  ctx: CommandContext,
  names: string[],
  action: (name: string) => Promise<string[]>,
  successKey: string,
): Promise<{ ok: string[]; extra: string[] }> {
  const ok: string[] = [];
  const extra: string[] = [];
  const failed: string[] = [];
  for (const raw of names) {
    const name = raw.toLowerCase();
    try {
      extra.push(...(await action(name)));
      ok.push(name);
    } catch (err) {
      if (!(err instanceof CogError)) ctx.bot.log.error({ err, cog: name }, 'Cog-Aktion fehlgeschlagen');
      failed.push(`**${name}**: ${cogErrorText(ctx, err)}`);
    }
  }
  const lines: string[] = [];
  if (ok.length) lines.push(`✅ ${ctx.t(successKey, { cogs: ok.map((n) => inlineCode(n)).join(', ') })}`);
  if (extra.length) lines.push(`➕ ${ctx.t('cogs.alsoAffected', { cogs: [...new Set(extra)].map((n) => inlineCode(n)).join(', ') })}`);
  if (failed.length) lines.push(`❌ ${ctx.t('cogs.failed')}\n${failed.join('\n')}`);
  await ctx.reply(lines.join('\n'));
  return { ok, extra };
}

const cogNamesOption = {
  name: 'cogs',
  description: 'Ein oder mehrere Cog-Namen',
  type: OptionType.String,
  required: true,
  variadic: true,
} as const;

function cogCommands(): CommandDefinition[] {
  return [
    {
      name: 'load',
      description: 'Lädt Cogs.',
      options: [cogNamesOption],
      permissions: { level: 'owner' },
      examples: ['load general', 'load mod modlog'],
      run: async (ctx) => {
        const { ok, extra } = await batch(ctx, ctx.arg<string[]>('cogs'), async (n) => ctx.bot.cogs.load(n), 'cogs.loaded');
        // mitgeladene Abhängigkeiten ebenfalls merken
        ctx.bot.rememberCogs([...ok, ...extra], true);
      },
    },
    {
      name: 'unload',
      description: 'Entlädt Cogs.',
      options: [cogNamesOption],
      permissions: { level: 'owner' },
      run: async (ctx) => {
        const { ok } = await batch(
          ctx,
          ctx.arg<string[]>('cogs'),
          async (n) => {
            await ctx.bot.cogs.unload(n);
            return [];
          },
          'cogs.unloaded',
        );
        ctx.bot.rememberCogs(ok, false);
      },
    },
    {
      name: 'reload',
      description: 'Lädt Cogs neu (nicht geladene werden geladen).',
      options: [cogNamesOption],
      permissions: { level: 'owner' },
      run: async (ctx) => {
        const { ok, extra } = await batch(
          ctx,
          ctx.arg<string[]>('cogs'),
          async (n) => (ctx.bot.cogs.isLoaded(n) ? ctx.bot.cogs.reload(n) : ctx.bot.cogs.load(n)),
          'cogs.reloaded',
        );
        ctx.bot.rememberCogs([...ok, ...extra], true);
      },
    },
    {
      name: 'cogs',
      description: 'Zeigt geladene und nicht geladene Cogs.',
      permissions: { level: 'owner' },
      run: async (ctx) => {
        const available = ctx.bot.cogs.discover();
        const loaded = [...ctx.bot.cogs.loaded.values()].filter((c) => !c.manifest.hidden).map((c) => c.name).sort();
        const unloaded = [...available.keys()].filter((n) => !ctx.bot.cogs.isLoaded(n) && !available.get(n)!.manifest.hidden).sort();
        await ctx.sendEmbed({
          title: ctx.t('cogs.title'),
          color: Colors.info,
          fields: [
            { name: ctx.t('cogs.loadedCount', { count: loaded.length }), value: codeBlock(loaded.length ? `+ ${loaded.join(', ')}` : '-', 'diff') },
            { name: ctx.t('cogs.unloadedCount', { count: unloaded.length }), value: codeBlock(unloaded.length ? `- ${unloaded.join(', ')}` : '-', 'diff') },
          ],
        });
      },
    },
  ];
}

function botCommands(): CommandDefinition[] {
  return [
    {
      name: 'help',
      description: 'Zeigt die Hilfe – für alles, einen Cog oder einen Befehl.',
      aliases: ['hilfe'],
      options: [{ name: 'befehl', description: 'Befehl oder Cog', type: OptionType.String, rest: true }],
      examples: ['help', 'help mod', 'help set name'],
      run: async (ctx) => {
        const query = ctx.arg<string | undefined>('befehl')?.trim();
        if (!query) return ctx.bot.help.sendBotHelp(ctx);
        const command = ctx.bot.registry.find(query);
        if (command && (await ctx.bot.help.canRun(ctx, command))) return ctx.bot.help.sendCommandHelp(ctx, command);
        const cog = [...ctx.bot.cogs.loaded.values()].find(
          (c) => c.name === query.toLowerCase() || c.displayName.toLowerCase() === query.toLowerCase(),
        );
        if (cog && !cog.manifest.hidden) return ctx.bot.help.sendCogHelp(ctx, cog);
        await ctx.reply(ctx.t('help.notFound', { query }));
      },
    },
    {
      name: 'ping',
      description: 'Prüft, ob der Bot antwortet, und misst die Latenz.',
      cooldown: { rate: 3, per: 10, bucket: 'channel' },
      run: async (ctx) => {
        const start = Date.now();
        const msg = await ctx.reply('🏓 Pong!');
        const ms = Date.now() - start;
        await ctx.bot.platform.editMessage(msg.channel_id, msg.id, `🏓 Pong! ${ctx.t('core.ping.latency', { ms })}`).catch(() => undefined);
      },
    },
    {
      name: 'info',
      description: 'Informationen über den Bot.',
      run: async (ctx) => {
        const bot = ctx.bot;
        const owners = [...bot.owners()].map((id) => `<@${id}>`).join(', ') || '–';
        await ctx.sendEmbed({
          title: ctx.t('core.info.title', { name: bot.platform.user?.username ?? 'Bot' }),
          description: ctx.t('core.info.description'),
          color: Colors.info,
          fields: [
            { name: ctx.t('core.info.version'), value: `fluxer-redbot ${bot.version}`, inline: true },
            { name: 'Node.js', value: process.version, inline: true },
            { name: ctx.t('core.info.instance'), value: bot.env.baseUrl, inline: true },
            { name: ctx.t('core.info.servers'), value: String(bot.platform.guilds.size), inline: true },
            { name: ctx.t('core.info.cogs'), value: String(bot.cogs.loaded.size), inline: true },
            { name: ctx.t('core.info.commands'), value: String([...bot.registry.walk()].length), inline: true },
            { name: ctx.t('core.info.uptime'), value: humanizeSeconds((Date.now() - bot.startedAt.getTime()) / 1000, 2), inline: true },
            { name: ctx.t('core.info.prefix'), value: bot.prefixesFor(ctx.guildId).map(inlineCode).join(' '), inline: true },
            { name: ctx.t('core.info.memory'), value: `${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB`, inline: true },
            { name: ctx.t('core.info.owners'), value: owners },
          ],
          footer: `${os.type()} ${os.release()} • ${bot.env.timezone}`,
        });
      },
    },
    {
      name: 'uptime',
      description: 'Wie lange der Bot schon läuft.',
      run: async (ctx) => {
        const since = ctx.bot.startedAt;
        await ctx.reply(
          ctx.t('core.uptime', {
            since: formatDateTime(since, ctx.bot.env.timezone),
            duration: humanizeSeconds((Date.now() - since.getTime()) / 1000),
          }),
        );
      },
    },
    {
      name: 'invite',
      description: 'Zeigt den Einladungslink (OAuth2, Scope "bot").',
      permissions: { level: 'owner' },
      run: async (ctx) => {
        const url = ctx.bot.inviteUrl();
        await ctx.reply(url ? ctx.t('core.invite', { url }) : ctx.t('core.inviteUnknown'));
      },
    },
    {
      name: 'prefix',
      description: 'Zeigt oder ändert das Prefix dieses Servers.',
      run: async (ctx) => {
        const list = ctx.bot.prefixesFor(ctx.guildId).map(inlineCode).join(' ');
        await ctx.reply(ctx.t('core.prefix.current', { prefixes: list, mention: `@${ctx.bot.platform.user?.username ?? 'Bot'}` }));
      },
      subcommands: [
        {
          name: 'set',
          description: 'Setzt ein oder mehrere Prefixe für diesen Server.',
          guildOnly: true,
          permissions: { level: 'admin', member: ['ManageGuild'] },
          options: [{ name: 'prefixe', description: 'Neue(s) Prefix(e)', type: OptionType.String, required: true, variadic: true, max_length: 20 }],
          examples: ['prefix set ?', 'prefix set ! .'],
          run: async (ctx) => {
            const prefixes = [...new Set(ctx.arg<string[]>('prefixe'))].slice(0, 5);
            ctx.bot.core.guild(ctx.guildId!).set('prefixes', prefixes);
            await ctx.reply(ctx.t('core.prefix.set', { prefixes: prefixes.map(inlineCode).join(' ') }));
          },
        },
        {
          name: 'reset',
          description: 'Setzt das Prefix dieses Servers auf den Standard zurück.',
          guildOnly: true,
          permissions: { level: 'admin', member: ['ManageGuild'] },
          run: async (ctx) => {
            ctx.bot.core.guild(ctx.guildId!).clear('prefixes');
            await ctx.reply(ctx.t('core.prefix.reset', { prefixes: ctx.bot.globalPrefixes().map(inlineCode).join(' ') }));
          },
        },
      ],
    },
  ];
}

async function fetchImageAsDataUri(url: string, signal: AbortSignal): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
  if (!res.ok) throw new UserError(`HTTP ${res.status}`);
  const type = res.headers.get('content-type') ?? '';
  if (!type.startsWith('image/')) throw new UserError(`Kein Bild (${type || 'unbekannter Typ'})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 8 * 1024 * 1024) throw new UserError('Bild größer als 8 MB');
  return `data:${type.split(';')[0]};base64,${buf.toString('base64')}`;
}

function roleListCommand(kind: 'admin' | 'mod', add: boolean): CommandDefinition {
  const key = kind === 'admin' ? 'adminRoles' : 'modRoles';
  return {
    name: `${add ? 'add' : 'remove'}${kind}role`,
    description: add ? `Fügt eine ${kind === 'admin' ? 'Admin' : 'Mod'}-Rolle hinzu.` : `Entfernt eine ${kind === 'admin' ? 'Admin' : 'Mod'}-Rolle.`,
    guildOnly: true,
    permissions: { level: 'guildowner', member: ['Administrator'] },
    options: [{ name: 'rolle', description: 'Die Rolle', type: OptionType.Role, required: true }],
    run: async (ctx) => {
      const role = ctx.arg<APIRole>('rolle');
      const conf = ctx.bot.core.guild(ctx.guildId!);
      const list = conf.get<string[]>(key);
      if (add) {
        if (list.includes(role.id)) throw new CommandError('core.roles.already', { role: role.name });
        conf.set(key, [...list, role.id]);
      } else {
        if (!list.includes(role.id)) throw new CommandError('core.roles.notSet', { role: role.name });
        conf.set(key, list.filter((r) => r !== role.id));
      }
      await ctx.reply(ctx.t(add ? `core.roles.added.${kind}` : `core.roles.removed.${kind}`, { role: role.name }));
    },
  };
}

function setCommand(): CommandDefinition {
  return {
    name: 'set',
    description: 'Bot- und Server-Einstellungen.',
    subcommands: [
      {
        name: 'name',
        description: 'Ändert den Benutzernamen des Bots.',
        permissions: { level: 'owner' },
        options: [{ name: 'name', description: 'Neuer Name', type: OptionType.String, required: true, min_length: 2, max_length: 32 }],
        run: async (ctx) => {
          await ctx.bot.platform.editCurrentUser({ username: ctx.arg<string>('name') });
          await ctx.reply(ctx.t('core.set.name', { name: ctx.arg<string>('name') }));
        },
      },
      {
        name: 'avatar',
        description: 'Ändert den Avatar des Bots (URL oder Bild-Anhang; "entfernen" zum Löschen).',
        permissions: { level: 'owner' },
        options: [
          { name: 'url', description: 'Bild-URL oder "entfernen"', type: OptionType.String },
          { name: 'bild', description: 'Bild als Anhang', type: OptionType.Attachment },
        ],
        run: async (ctx) => {
          const url = ctx.arg<string | undefined>('url');
          const attachment = ctx.arg<{ url: string } | undefined>('bild');
          if (url && ['entfernen', 'remove', 'reset'].includes(url.toLowerCase())) {
            await ctx.bot.platform.editCurrentUser({ avatar: null });
            return ctx.reply(ctx.t('core.set.avatarRemoved'));
          }
          const source = attachment?.url ?? url;
          if (!source) throw new CommandError('core.set.avatarMissing');
          await ctx.typing();
          const dataUri = await fetchImageAsDataUri(source, AbortSignal.timeout(30_000));
          await ctx.bot.platform.editCurrentUser({ avatar: dataUri });
          await ctx.reply(ctx.t('core.set.avatar'));
        },
      },
      {
        name: 'status',
        description: 'Setzt Online-Status und optional einen Status-Text.',
        permissions: { level: 'owner' },
        options: [
          { name: 'status', description: 'online, abwesend, dnd oder unsichtbar', type: OptionType.String, required: true, choices: STATUS_CHOICES },
          { name: 'text', description: 'Status-Text (optional)', type: OptionType.String, rest: true, max_length: 128 },
        ],
        examples: ['set status online Hilfe mit !help', 'set status dnd'],
        run: async (ctx) => {
          const status = ctx.arg<BotStatus>('status');
          const text = ctx.arg<string | undefined>('text') ?? null;
          ctx.bot.core.global().set('status', { status, text });
          ctx.bot.platform.setPresence(status, text);
          await ctx.reply(ctx.t('core.set.status', { status, text: text ?? '–' }));
        },
      },
      {
        name: 'globalprefix',
        description: 'Setzt die globalen Prefixe ("reset" = Standard aus .env).',
        permissions: { level: 'owner' },
        options: [{ name: 'prefixe', description: 'Prefix(e)', type: OptionType.String, required: true, variadic: true, max_length: 20 }],
        run: async (ctx) => {
          const list = [...new Set(ctx.arg<string[]>('prefixe'))].slice(0, 5);
          if (list.length === 1 && list[0]!.toLowerCase() === 'reset') ctx.bot.core.global().clear('prefixes');
          else ctx.bot.core.global().set('prefixes', list);
          await ctx.reply(ctx.t('core.prefix.global', { prefixes: ctx.bot.globalPrefixes().map(inlineCode).join(' ') }));
        },
      },
      {
        name: 'locale',
        description: 'Setzt die Standardsprache des Bots.',
        permissions: { level: 'owner' },
        options: [{ name: 'sprache', description: 'Sprachcode, z. B. de', type: OptionType.String, required: true }],
        run: async (ctx) => {
          const lang = ctx.arg<string>('sprache').toLowerCase();
          const available = ctx.bot.i18n.locales();
          if (!available.includes(lang)) throw new CommandError('core.set.localeUnknown', { locales: available.join(', ') });
          ctx.bot.core.global().set('locale', lang);
          await ctx.reply(ctx.t('core.set.locale', { locale: lang }));
        },
      },
      {
        name: 'serverlocale',
        description: 'Setzt die Sprache für diesen Server ("reset" = Bot-Standard).',
        guildOnly: true,
        permissions: { level: 'admin', member: ['ManageGuild'] },
        options: [{ name: 'sprache', description: 'Sprachcode oder reset', type: OptionType.String, required: true }],
        run: async (ctx) => {
          const lang = ctx.arg<string>('sprache').toLowerCase();
          const conf = ctx.bot.core.guild(ctx.guildId!);
          if (lang === 'reset') conf.clear('locale');
          else {
            const available = ctx.bot.i18n.locales();
            if (!available.includes(lang)) throw new CommandError('core.set.localeUnknown', { locales: available.join(', ') });
            conf.set('locale', lang);
          }
          await ctx.reply(ctx.t('core.set.locale', { locale: ctx.bot.localeFor(ctx.guildId) }));
        },
      },
      {
        name: 'embeds',
        description: 'Embeds global an/aus (aus = reine Textnachrichten).',
        permissions: { level: 'owner' },
        options: [{ name: 'aktiv', description: 'an oder aus', type: OptionType.Boolean, required: true }],
        run: async (ctx) => {
          ctx.bot.core.global().set('embeds', ctx.arg<boolean>('aktiv'));
          await ctx.reply(ctx.t(ctx.arg<boolean>('aktiv') ? 'core.set.embedsOn' : 'core.set.embedsOff'));
        },
      },
      {
        name: 'serverembeds',
        description: 'Embeds für diesen Server an/aus.',
        guildOnly: true,
        permissions: { level: 'admin', member: ['ManageGuild'] },
        options: [{ name: 'aktiv', description: 'an oder aus', type: OptionType.Boolean, required: true }],
        run: async (ctx) => {
          ctx.bot.core.guild(ctx.guildId!).set('embeds', ctx.arg<boolean>('aktiv'));
          await ctx.reply(ctx.t(ctx.arg<boolean>('aktiv') ? 'core.set.embedsOn' : 'core.set.embedsOff'));
        },
      },
      roleListCommand('admin', true),
      roleListCommand('admin', false),
      roleListCommand('mod', true),
      roleListCommand('mod', false),
      {
        name: 'showsettings',
        description: 'Zeigt die aktuellen Einstellungen.',
        aliases: ['show'],
        run: async (ctx) => {
          const bot = ctx.bot;
          const fields = [
            { name: ctx.t('core.settings.globalPrefix'), value: bot.globalPrefixes().map(inlineCode).join(' '), inline: true },
            { name: ctx.t('core.settings.locale'), value: bot.localeFor(ctx.guildId), inline: true },
            { name: ctx.t('core.settings.embeds'), value: (await bot.canEmbed(ctx.guildId, ctx.channelId)) ? '✅' : '❌', inline: true },
          ];
          if (ctx.guildId) {
            const g = bot.core.guild(ctx.guildId);
            const roleName = (id: string) => ctx.guild?.roles.get(id)?.name ?? id;
            fields.push(
              { name: ctx.t('core.settings.serverPrefix'), value: bot.prefixesFor(ctx.guildId).map(inlineCode).join(' '), inline: true },
              { name: ctx.t('core.settings.adminRoles'), value: g.get<string[]>('adminRoles').map(roleName).join(', ') || '–', inline: false },
              { name: ctx.t('core.settings.modRoles'), value: g.get<string[]>('modRoles').map(roleName).join(', ') || '–', inline: false },
            );
          }
          await ctx.sendEmbed({ title: ctx.t('core.settings.title'), color: Colors.info, fields });
        },
      },
    ],
  };
}

function ownerCommands(): CommandDefinition[] {
  return [
    {
      name: 'shutdown',
      description: 'Fährt den Bot herunter.',
      permissions: { level: 'owner' },
      run: async (ctx) => {
        await ctx.reply(ctx.t('core.shutdown'));
        setTimeout(() => void ctx.bot.shutdown(EXIT_SHUTDOWN), 500);
      },
    },
    {
      name: 'restart',
      description: 'Startet den Bot neu (Docker startet den Container neu).',
      permissions: { level: 'owner' },
      run: async (ctx) => {
        await ctx.reply(ctx.t('core.restart'));
        setTimeout(() => void ctx.bot.shutdown(EXIT_RESTART), 500);
      },
    },
    {
      name: 'owner',
      description: 'Bot-Owner verwalten.',
      permissions: { level: 'owner' },
      run: async (ctx) => {
        const fromEnv = new Set(ctx.bot.env.ownerIds);
        const lines = [...ctx.bot.owners()].map((id) => {
          const tag = fromEnv.has(id) ? ' (.env)' : id === ctx.bot.appOwnerId ? ` (${ctx.t('core.owner.app')})` : '';
          return `• <@${id}> \`${id}\`${tag}`;
        });
        await ctx.reply(`${ctx.t('core.owner.list')}\n${lines.join('\n') || '–'}`);
      },
      subcommands: [
        {
          name: 'add',
          description: 'Fügt einen Owner hinzu (voller Zugriff auf den Bot!).',
          options: [{ name: 'user', description: 'Benutzer', type: OptionType.User, required: true }],
          run: async (ctx) => {
            const user = ctx.arg<ResolvedUser>('user');
            if (ctx.bot.isOwner(user.id)) throw new CommandError('core.owner.already');
            const ok = await ctx.confirm(ctx.t('core.owner.confirm', { user: `<@${user.id}>` }));
            if (!ok) return ctx.reply(ctx.t('common.cancelled'));
            ctx.bot.core.global().update<string[]>('owners', (l) => [...(l ?? []), user.id]);
            await ctx.reply(ctx.t('core.owner.added', { user: `<@${user.id}>` }));
          },
        },
        {
          name: 'remove',
          description: 'Entfernt einen Owner.',
          options: [{ name: 'user', description: 'Benutzer', type: OptionType.User, required: true }],
          run: async (ctx) => {
            const user = ctx.arg<ResolvedUser>('user');
            if (ctx.bot.env.ownerIds.includes(user.id)) throw new CommandError('core.owner.envOwner');
            const list = ctx.bot.core.global().get<string[]>('owners');
            if (!list.includes(user.id)) throw new CommandError('core.owner.notOwner');
            ctx.bot.core.global().set('owners', list.filter((id) => id !== user.id));
            await ctx.reply(ctx.t('core.owner.removed', { user: `<@${user.id}>` }));
          },
        },
      ],
    },
    {
      name: 'traceback',
      description: 'Schickt die letzten unerwarteten Fehler per DM.',
      permissions: { level: 'owner' },
      options: [{ name: 'anzahl', description: 'Wie viele (Standard 1)', type: OptionType.Integer, min_value: 1, max_value: 5, default: 1 }],
      run: async (ctx) => {
        const errors = ctx.bot.recentErrors.slice(0, ctx.arg<number>('anzahl'));
        if (!errors.length) return ctx.reply(ctx.t('core.traceback.none'));
        for (const e of errors) {
          const header = `**${e.id}** – \`${e.command}\` – ${formatDateTime(e.at, ctx.bot.env.timezone)}`;
          for (const page of pagify(e.stack, { pageLength: 1900, wrap: ['```\n', '\n```'] })) {
            await ctx.dm(`${header}\n${page}`);
          }
        }
        await ctx.tick();
      },
    },
    {
      name: 'tasks',
      description: 'Zeigt alle geplanten Tasks.',
      permissions: { level: 'owner' },
      subcommands: [
        {
          name: 'run',
          description: 'Führt einen geplanten Task sofort aus.',
          options: [
            { name: 'besitzer', description: 'z. B. cog:mod', type: OptionType.String, required: true },
            { name: 'name', description: 'Taskname', type: OptionType.String, required: true },
          ],
          run: async (ctx) => {
            const ok = await ctx.bot.scheduler.runNow(ctx.arg<string>('besitzer'), ctx.arg<string>('name'));
            if (!ok) throw new CommandError('core.tasks.notFound');
            await ctx.tick();
          },
        },
      ],
      run: async (ctx) => {
        const tasks = ctx.bot.scheduler.list();
        if (!tasks.length) return ctx.reply(ctx.t('core.tasks.none'));
        const lines = tasks.map(
          (t) =>
            `• \`${t.owner}\` **${t.name}** – ${t.nextRun ? formatDateTime(t.nextRun, ctx.bot.env.timezone) : '–'}${t.running ? ' ⏳' : ''}${t.lastError ? ` ⚠️ ${t.lastError}` : ''}`,
        );
        await ctx.paginate(pagify(lines.join('\n'), { pageLength: 1800 }).map((p) => embed({ title: ctx.t('core.tasks.title'), description: p })));
      },
    },
  ];
}

function autoimmuneCommand(): CommandDefinition {
  const target = { name: 'ziel', description: 'Benutzer oder Rolle', type: OptionType.Mentionable, required: true } as const;
  return {
    name: 'autoimmune',
    description: 'Ausnahmen von Automod, Filtern und Einladungssperre verwalten.',
    guildOnly: true,
    permissions: { level: 'admin', member: ['ManageGuild'] },
    run: async (ctx) => {
      const list = ctx.bot.core.guild(ctx.guildId!).get<string[]>('immune');
      const g = ctx.guild;
      const names = list.map((id) => (g?.roles.has(id) ? `@${g.roles.get(id)!.name}` : `<@${id}>`));
      await ctx.reply(`${ctx.t('core.immune.list')}\n${names.join(', ') || '–'}\n${ctx.t('core.immune.hint')}`);
    },
    subcommands: [
      {
        name: 'add',
        description: 'Fügt eine Ausnahme hinzu.',
        options: [target],
        run: async (ctx) => {
          const m = ctx.arg<ResolvedMentionable>('ziel');
          ctx.bot.core.guild(ctx.guildId!).update<string[]>('immune', (l) => [...new Set([...(l ?? []), m.id])]);
          await ctx.reply(ctx.t('core.immune.added'));
        },
      },
      {
        name: 'remove',
        description: 'Entfernt eine Ausnahme.',
        options: [target],
        run: async (ctx) => {
          const m = ctx.arg<ResolvedMentionable>('ziel');
          ctx.bot.core.guild(ctx.guildId!).update<string[]>('immune', (l) => (l ?? []).filter((id) => id !== m.id));
          await ctx.reply(ctx.t('core.immune.removed'));
        },
      },
      {
        name: 'check',
        description: 'Prüft, ob ein Benutzer ausgenommen ist.',
        options: [{ name: 'user', description: 'Benutzer', type: OptionType.User, required: true }],
        run: async (ctx) => {
          const user = ctx.arg<ResolvedUser>('user');
          const immune = await ctx.bot.isImmune(ctx.guildId!, user.id);
          await ctx.reply(ctx.t(immune ? 'core.immune.yes' : 'core.immune.no', { user: `<@${user.id}>` }));
        },
      },
    ],
  };
}

export const coreCogDefinition: CogDefinition = {
  setup(cog) {
    for (const def of [...cogCommands(), ...botCommands(), setCommand(), ...ownerCommands(), autoimmuneCommand()]) cog.command(def);
  },
};
