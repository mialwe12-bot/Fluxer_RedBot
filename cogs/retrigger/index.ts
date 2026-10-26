import {
  defineCog,
  embed,
  formatDateTime,
  OptionType,
  pagify,
  UserError,
  type APIMessage,
  type Cog,
  type CommandContext,
  type CommandDefinition,
} from '@bot/sdk';
import type { ModlogApi } from '../modlog/index.js';

export type TriggerType = 'text' | 'dm' | 'react' | 'delete' | 'command' | 'kick' | 'ban';

export interface Trigger {
  name: string;
  pattern: string;
  type: TriggerType;
  /** Text (text/dm), Befehl (command) oder Emojis mit Leerzeichen (react). */
  response: string;
  authorId: string;
  createdAt: number;
  cooldown: number;
  ignoredChannels: string[];
  enabled: boolean;
  count: number;
}

const MAX_PATTERN = 300;
const MAX_TEXT = 2000;

/**
 * Kompiliert ein Muster sicher(er): Längenlimit und eine Heuristik gegen katastrophales Backtracking
 * (verschachtelte Quantoren wie (a+)+). JavaScript-RegExps lassen sich nicht abbrechen – daher Admin-only.
 * Präfix "(?i)" schaltet Groß/Klein-Unabhängigkeit ein (wie bei Red).
 */
export function compilePattern(pattern: string): RegExp {
  if (pattern.length > MAX_PATTERN) throw new Error('zu lang');
  if (/\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)[+*{]/.test(pattern)) throw new Error('verschachtelte Quantoren');
  let flags = 'u';
  let body = pattern;
  if (body.startsWith('(?i)')) {
    flags += 'i';
    body = body.slice(4);
  }
  return new RegExp(body, flags);
}

/** Platzhalter in Antworten: {user}, {user.name}, {channel}, {server}, {count}, {0} {1} … (Regex-Gruppen). */
export function renderResponse(template: string, m: Pick<APIMessage, 'author' | 'channel_id'>, match: RegExpExecArray, extra: { server: string; count: number }): string {
  return template.replace(/\{(user(?:\.name)?|channel|server|count|\d+)\}/g, (_all, key: string) => {
    if (key === 'user') return `<@${m.author.id}>`;
    if (key === 'user.name') return m.author.username;
    if (key === 'channel') return `<#${m.channel_id}>`;
    if (key === 'server') return extra.server;
    if (key === 'count') return String(extra.count);
    return match[Number(key)] ?? '';
  });
}

export default defineCog({
  setup(cog: Cog) {
    cog.config.registerGuild({ triggers: {} as Record<string, Trigger> });
    const p = () => cog.platform;
    const modlog = () => cog.bot.cogApi<ModlogApi>('modlog');
    const compiled = new Map<string, RegExp>();
    const lastFired = new Map<string, number>();
    /** Nachrichten, die von command-Triggern erzeugt wurden – nicht erneut auslösen. */
    const synthetic = new WeakSet<object>();

    const regexFor = (guildId: string, t: Trigger): RegExp | null => {
      const key = `${guildId}:${t.name}:${t.pattern}`;
      if (!compiled.has(key)) {
        try {
          compiled.set(key, compilePattern(t.pattern));
        } catch {
          return null;
        }
      }
      return compiled.get(key)!;
    };

    async function fire(guildId: string, t: Trigger, m: APIMessage, match: RegExpExecArray): Promise<void> {
      const server = p().getGuild(guildId)?.name ?? '';
      const count = t.count + 1;
      const text = () => renderResponse(t.response, m, match, { server, count });
      switch (t.type) {
        case 'text':
          await cog.bot.send(m.channel_id, { content: text(), allowed_mentions: { parse: ['users'] } });
          break;
        case 'dm':
          await p().sendDM(m.author.id, text()).catch(() => undefined);
          break;
        case 'react':
          for (const emoji of t.response.split(/\s+/).filter(Boolean)) {
            const e = /^<a?:(\w+):(\d+)>$/.exec(emoji);
            await p().addReaction(m.channel_id, m.id, e ? `${e[1]}:${e[2]}` : emoji).catch(() => undefined);
          }
          break;
        case 'delete':
          await p().deleteMessage(m.channel_id, m.id, `ReTrigger ${t.name}`).catch(() => undefined);
          break;
        case 'command': {
          const prefix = cog.bot.prefixesFor(guildId)[0] ?? '!';
          const fake = { ...m, content: `${prefix}${text()}` };
          synthetic.add(fake);
          await cog.bot.dispatcher.handleMessage(fake);
          break;
        }
        case 'kick':
        case 'ban': {
          if (cog.bot.hierarchyProblem(guildId, p().user?.id ?? '', m.author.id)) break;
          const reason = cog.tg(guildId, 'modReason', { name: t.name });
          if (t.type === 'kick') await p().kickMember(guildId, m.author.id, reason);
          else await p().banMember(guildId, m.author.id, { reason, deleteMessageSeconds: 86400 });
          await modlog()?.createCase({ guildId, action: t.type, targetId: m.author.id, moderatorId: p().user?.id ?? null, reason });
          break;
        }
      }
      cog.config.guild(guildId).update<Record<string, Trigger>>('triggers', (all) =>
        all[t.name] ? { ...all, [t.name]: { ...all[t.name]!, count } } : all,
      );
    }

    cog.on('MESSAGE_CREATE', async (m: APIMessage) => {
      const guildId = m.guild_id;
      if (!guildId || !m.author || (m.author as { bot?: boolean }).bot || synthetic.has(m)) return;
      const content = (m.content ?? '').slice(0, MAX_TEXT);
      if (!content) return;
      const triggers = Object.values(cog.config.guild(guildId).get<Record<string, Trigger>>('triggers'));
      if (!triggers.length) return;
      const isCommand = cog.bot.prefixesFor(guildId).some((pre) => content.startsWith(pre));
      for (const t of triggers) {
        if (!t.enabled || t.ignoredChannels.includes(m.channel_id)) continue;
        // Befehle lösen nur Lösch-Trigger aus (verhindert Schleifen)
        if (isCommand && t.type !== 'delete') continue;
        const re = regexFor(guildId, t);
        const match = re?.exec(content);
        if (!match) continue;
        if (['delete', 'kick', 'ban'].includes(t.type) && (await cog.bot.isImmune(guildId, m.author.id))) continue;
        const key = `${guildId}:${t.name}`;
        if (t.cooldown > 0 && Date.now() - (lastFired.get(key) ?? 0) < t.cooldown * 1000) continue;
        lastFired.set(key, Date.now());
        try {
          await fire(guildId, t, m, match);
        } catch (err) {
          cog.log.warn({ err, trigger: t.name, guildId }, 'Trigger fehlgeschlagen');
        }
      }
    });

    // ------------------------------------------------------------------ Befehle
    const nameOpt = { name: 'name', description: 'Name des Triggers', type: OptionType.String, required: true, max_length: 40 } as const;
    const regexOpt = { name: 'regex', description: 'Regulärer Ausdruck (Leerzeichen → "in Anführungszeichen", (?i) = ohne Groß/Klein)', type: OptionType.String, required: true } as const;

    const getTrigger = (ctx: CommandContext, name: string): Trigger => {
      const t = cog.config.guild(ctx.guildId!).get<Record<string, Trigger>>('triggers')[name.toLowerCase()];
      if (!t) throw new UserError(ctx.t('notFound', { name }));
      return t;
    };

    const save = (ctx: CommandContext, type: TriggerType, response: string) => {
      const name = ctx.arg<string>('name').toLowerCase();
      const pattern = ctx.arg<string>('regex');
      try {
        compilePattern(pattern);
      } catch (err) {
        throw new UserError(ctx.t('badRegex', { reason: (err as Error).message }));
      }
      const all = cog.config.guild(ctx.guildId!).get<Record<string, Trigger>>('triggers');
      if (all[name]) throw new UserError(ctx.t('exists', { name }));
      if (Object.keys(all).length >= 100) throw new UserError(ctx.t('tooMany'));
      const trigger: Trigger = {
        name,
        pattern,
        type,
        response,
        authorId: ctx.author.id,
        createdAt: Date.now(),
        cooldown: 0,
        ignoredChannels: [],
        enabled: true,
        count: 0,
      };
      cog.config.guild(ctx.guildId!).set('triggers', { ...all, [name]: trigger });
      return ctx.reply(ctx.t('created', { name, type: ctx.t(`types.${type}`) }));
    };

    const create = (type: TriggerType, description: string, responseOpt?: { name: string; description: string; variadic?: boolean }, extraPerms?: CommandDefinition['permissions']): CommandDefinition => ({
      name: type,
      description,
      ...(extraPerms ? { permissions: extraPerms } : {}),
      options: [
        nameOpt,
        regexOpt,
        ...(responseOpt
          ? [
              responseOpt.variadic
                ? { name: responseOpt.name, description: responseOpt.description, type: OptionType.String, required: true, variadic: true }
                : { name: responseOpt.name, description: responseOpt.description, type: OptionType.String, required: true, rest: true },
            ]
          : []),
      ],
      run: (ctx) => {
        const raw = responseOpt ? ctx.arg<string | string[]>(responseOpt.name) : '';
        return save(ctx, type, Array.isArray(raw) ? raw.join(' ') : raw);
      },
    });

    cog.group({
      name: 'retrigger',
      description: 'Automatische Reaktionen auf Nachrichten (reguläre Ausdrücke).',
      aliases: ['trigger'],
      guildOnly: true,
      permissions: { level: 'admin', member: ['ManageGuild'] },
      subcommands: [
        { ...create('text', 'Antwortet mit Text.', { name: 'antwort', description: 'Antworttext ({user}, {channel}, {0}…)' }), examples: ['retrigger text hallo "(?i)^hallo$" Hallo {user}! 👋'] },
        create('dm', 'Schickt dem Absender eine DM.', { name: 'antwort', description: 'DM-Text' }),
        create('react', 'Reagiert mit Emojis.', { name: 'emojis', description: 'Ein oder mehrere Emojis', variadic: true }),
        create('delete', 'Löscht passende Nachrichten.'),
        create('command', 'Führt einen Befehl aus (als Absender).', { name: 'befehl', description: 'Befehl ohne Prefix, z. B. "help"' }),
        create('kick', 'Kickt den Absender.', undefined, { level: 'admin', member: ['KickMembers'], bot: ['KickMembers'] }),
        create('ban', 'Bannt den Absender.', undefined, { level: 'admin', member: ['BanMembers'], bot: ['BanMembers'] }),
        {
          name: 'list',
          description: 'Alle Trigger.',
          run: async (ctx) => {
            const all = Object.values(cog.config.guild(ctx.guildId!).get<Record<string, Trigger>>('triggers'));
            if (!all.length) return ctx.reply(ctx.t('none'));
            const lines = all.map((t) => `${t.enabled ? '🟢' : '⚪'} **${t.name}** – ${ctx.t(`types.${t.type}`)} – \`${t.pattern.replace(/`/g, 'ˋ')}\` – ${t.count}×`);
            await ctx.paginate(pagify(lines.join('\n'), { pageLength: 1800 }).map((pg) => embed({ title: ctx.t('listTitle'), description: pg })));
          },
        },
        {
          name: 'info',
          description: 'Details zu einem Trigger.',
          options: [nameOpt],
          run: async (ctx) => {
            const t = getTrigger(ctx, ctx.arg<string>('name'));
            await ctx.sendEmbed({
              title: `ReTrigger: ${t.name}`,
              fields: [
                { name: ctx.t('fields.type'), value: ctx.t(`types.${t.type}`), inline: true },
                { name: ctx.t('fields.status'), value: t.enabled ? ctx.t('common.on') : ctx.t('common.off'), inline: true },
                { name: ctx.t('fields.count'), value: String(t.count), inline: true },
                { name: 'Regex', value: `\`${t.pattern.replace(/`/g, 'ˋ')}\`` },
                { name: ctx.t('fields.response'), value: t.response.slice(0, 1000) || '–' },
                { name: ctx.t('fields.cooldown'), value: `${t.cooldown} s`, inline: true },
                { name: ctx.t('fields.ignored'), value: t.ignoredChannels.map((c) => `<#${c}>`).join(' ') || '–', inline: true },
                { name: ctx.t('fields.author'), value: `<@${t.authorId}> – ${formatDateTime(t.createdAt)}` },
              ],
            });
          },
        },
        {
          name: 'remove',
          description: 'Löscht einen Trigger.',
          aliases: ['del'],
          options: [nameOpt],
          run: async (ctx) => {
            const t = getTrigger(ctx, ctx.arg<string>('name'));
            cog.config.guild(ctx.guildId!).update<Record<string, Trigger>>('triggers', (all) => {
              const { [t.name]: _gone, ...rest } = all;
              return rest;
            });
            await ctx.reply(ctx.t('removed', { name: t.name }));
          },
        },
        {
          name: 'toggle',
          description: 'Trigger an/aus.',
          options: [nameOpt],
          run: async (ctx) => {
            const t = getTrigger(ctx, ctx.arg<string>('name'));
            cog.config.guild(ctx.guildId!).update<Record<string, Trigger>>('triggers', (all) => ({ ...all, [t.name]: { ...t, enabled: !t.enabled } }));
            await ctx.reply(ctx.t(t.enabled ? 'toggledOff' : 'toggledOn', { name: t.name }));
          },
        },
        {
          name: 'cooldown',
          description: 'Mindestabstand zwischen zwei Auslösungen (Sekunden, 0 = aus).',
          options: [nameOpt, { name: 'sekunden', description: 'Sekunden', type: OptionType.Integer, required: true, min_value: 0, max_value: 86400 }],
          run: async (ctx) => {
            const t = getTrigger(ctx, ctx.arg<string>('name'));
            cog.config.guild(ctx.guildId!).update<Record<string, Trigger>>('triggers', (all) => ({ ...all, [t.name]: { ...t, cooldown: ctx.arg<number>('sekunden') } }));
            await ctx.tick();
          },
        },
        {
          name: 'ignore',
          description: 'Trigger in einem Kanal ignorieren (umschalten).',
          options: [nameOpt, { name: 'kanal', description: 'Kanal (Standard: dieser)', type: OptionType.Channel }],
          run: async (ctx) => {
            const t = getTrigger(ctx, ctx.arg<string>('name'));
            const ch = ctx.arg<{ id: string } | undefined>('kanal')?.id ?? ctx.channelId;
            const ignored = t.ignoredChannels.includes(ch) ? t.ignoredChannels.filter((c) => c !== ch) : [...t.ignoredChannels, ch];
            cog.config.guild(ctx.guildId!).update<Record<string, Trigger>>('triggers', (all) => ({ ...all, [t.name]: { ...t, ignoredChannels: ignored } }));
            await ctx.reply(ctx.t(ignored.includes(ch) ? 'ignoreOn' : 'ignoreOff', { channel: `<#${ch}>` }));
          },
        },
      ],
    });
  },
});
