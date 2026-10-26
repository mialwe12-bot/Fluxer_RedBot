import {
  defineCog,
  embed,
  humanizeSeconds,
  OptionType,
  takeDuration,
  UserError,
  type APIMessage,
  type Cog,
  type CommandContext,
} from '@bot/sdk';
import type { ModlogApi } from '../modlog/index.js';
import type { WarningsApi } from '../warnings/index.js';

export type Action = 'delete' | 'warn' | 'timeout' | 'kick' | 'ban';
export const ACTIONS: Action[] = ['delete', 'warn', 'timeout', 'kick', 'ban'];

export interface Rule {
  enabled: boolean;
  action: Action;
  /** Dauer für timeout (Sekunden). */
  duration: number;
  [param: string]: unknown;
}

/** Standardregeln. Parameter je Regel sind über `automod set <regel> <parameter> <wert>` änderbar. */
export const DEFAULT_RULES: Record<string, Rule> = {
  spam: { enabled: true, action: 'timeout', duration: 600, max: 6, seconds: 8 },
  mentions: { enabled: true, action: 'timeout', duration: 3600, max: 6 },
  duplicates: { enabled: true, action: 'delete', duration: 600, max: 4, seconds: 60 },
  caps: { enabled: false, action: 'delete', duration: 600, percent: 75, minLength: 15 },
  links: { enabled: false, action: 'delete', duration: 600, allow: [] as string[] },
  emojis: { enabled: false, action: 'delete', duration: 600, max: 12 },
  newlines: { enabled: false, action: 'delete', duration: 600, max: 25 },
};

const EMOJI_RE = /<a?:\w+:\d+>|\p{Extended_Pictographic}/gu;
const LINK_RE = /https?:\/\/([^\s/<>]+)/gi;

/** Reine Prüffunktionen (ohne Zustand) – testbar. Liefert die Regel, die zuschlägt. */
export function checkStatic(rules: Record<string, Rule>, m: Pick<APIMessage, 'content' | 'mentions' | 'mention_roles' | 'mention_everyone'>): string | null {
  const text = m.content ?? '';
  const r = rules;
  if (r.mentions?.enabled) {
    const count = new Set((m.mentions ?? []).map((u) => u.id)).size + (m.mention_roles ?? []).length + (m.mention_everyone ? 1 : 0);
    if (count >= Number(r.mentions.max)) return 'mentions';
  }
  if (r.caps?.enabled) {
    const letters = text.replace(/<[^>]+>|https?:\/\/\S+/g, '').match(/\p{L}/gu) ?? [];
    if (letters.length >= Number(r.caps.minLength)) {
      const upper = letters.filter((c) => c !== c.toLowerCase()).length;
      if ((upper / letters.length) * 100 >= Number(r.caps.percent)) return 'caps';
    }
  }
  if (r.links?.enabled) {
    const allow = (r.links.allow as string[]) ?? [];
    for (const match of text.matchAll(LINK_RE)) {
      const host = match[1]!.toLowerCase().replace(/^www\./, '');
      if (!allow.some((a) => host === a || host.endsWith(`.${a}`))) return 'links';
    }
  }
  if (r.emojis?.enabled && (text.match(EMOJI_RE) ?? []).length >= Number(r.emojis.max)) return 'emojis';
  if (r.newlines?.enabled && text.split('\n').length > Number(r.newlines.max)) return 'newlines';
  return null;
}

export default defineCog({
  setup(cog: Cog) {
    cog.config.registerGuild({
      enabled: false,
      logChannel: null as string | null,
      ignoredChannels: [] as string[],
      ignoredRoles: [] as string[],
      rules: DEFAULT_RULES,
    });
    const p = () => cog.platform;
    const modlog = () => cog.bot.cogApi<ModlogApi>('modlog');
    const rulesOf = (guildId: string): Record<string, Rule> => {
      const stored = cog.config.guild(guildId).get<Record<string, Rule>>('rules');
      const out: Record<string, Rule> = {};
      for (const [name, def] of Object.entries(DEFAULT_RULES)) out[name] = { ...def, ...(stored[name] ?? {}) };
      return out;
    };

    // Kurzzeit-Zähler pro Guild+User
    const recent = new Map<string, Array<{ t: number; content: string; id: string; channel: string }>>();
    const handling = new Set<string>();

    function checkRate(rules: Record<string, Rule>, key: string, m: APIMessage): { rule: string; ids: Array<{ id: string; channel: string }> } | null {
      const now = Date.now();
      const maxWindow = Math.max(Number(rules.spam!.seconds) || 0, Number(rules.duplicates!.seconds) || 0) * 1000;
      const list = (recent.get(key) ?? []).filter((e) => now - e.t < maxWindow);
      list.push({ t: now, content: (m.content ?? '').trim().toLowerCase(), id: m.id, channel: m.channel_id });
      recent.set(key, list.slice(-50));
      if (rules.spam!.enabled) {
        const inWindow = list.filter((e) => now - e.t < Number(rules.spam!.seconds) * 1000);
        if (inWindow.length >= Number(rules.spam!.max)) return { rule: 'spam', ids: inWindow };
      }
      if (rules.duplicates!.enabled && m.content) {
        const same = list.filter((e) => now - e.t < Number(rules.duplicates!.seconds) * 1000 && e.content === list[list.length - 1]!.content);
        if (same.length >= Number(rules.duplicates!.max)) return { rule: 'duplicates', ids: same };
      }
      return null;
    }

    async function punish(guildId: string, userId: string, ruleName: string, rule: Rule, messages: Array<{ id: string; channel: string }>, sample: string) {
      const reason = cog.tg(guildId, 'reason', { rule: cog.tg(guildId, `rules.${ruleName}`) });
      for (const m of messages) await p().deleteMessage(m.channel, m.id, reason).catch(() => undefined);
      const botId = p().user?.id ?? null;
      let done = cog.tg(guildId, 'actions.delete');
      try {
        switch (rule.action) {
          case 'warn': {
            const warnings = cog.bot.cogApi<WarningsApi>('warnings');
            if (warnings) {
              await warnings.warn(guildId, userId, botId ?? '', 1, reason);
              done = cog.tg(guildId, 'actions.warn');
            }
            break;
          }
          case 'timeout': {
            const until = new Date(Date.now() + rule.duration * 1000);
            await p().timeoutMember(guildId, userId, until, reason);
            await modlog()?.createCase({ guildId, action: 'automod', targetId: userId, moderatorId: botId, reason: `${reason} → Timeout`, until });
            done = `${cog.tg(guildId, 'actions.timeout')} (${humanizeSeconds(rule.duration)})`;
            break;
          }
          case 'kick':
            await p().kickMember(guildId, userId, reason);
            await modlog()?.createCase({ guildId, action: 'automod', targetId: userId, moderatorId: botId, reason: `${reason} → Kick` });
            done = cog.tg(guildId, 'actions.kick');
            break;
          case 'ban':
            await p().banMember(guildId, userId, { reason, deleteMessageSeconds: 3600 });
            await modlog()?.createCase({ guildId, action: 'automod', targetId: userId, moderatorId: botId, reason: `${reason} → Bann` });
            done = cog.tg(guildId, 'actions.ban');
            break;
          default:
            break;
        }
      } catch (err) {
        cog.log.warn({ err, guildId, userId, rule: ruleName }, 'Automod-Aktion fehlgeschlagen');
      }
      const log = cog.config.guild(guildId).get<string | null>('logChannel');
      if (log) {
        const e = embed({
          title: cog.tg(guildId, 'logTitle', { rule: cog.tg(guildId, `rules.${ruleName}`) }),
          fields: [
            { name: cog.tg(guildId, 'common.user'), value: `<@${userId}> (\`${userId}\`)`, inline: true },
            { name: cog.tg(guildId, 'logAction'), value: done, inline: true },
            { name: cog.tg(guildId, 'logSample'), value: sample.slice(0, 1000) || '–' },
          ],
          timestamp: new Date(),
          color: 0xe74c3c,
        });
        await cog.bot.send(log, await cog.bot.adaptPayload({ embeds: [e] }, guildId, log)).catch(() => undefined);
      }
    }

    cog.on('MESSAGE_CREATE', async (m: APIMessage) => {
      const guildId = m.guild_id;
      if (!guildId || !m.author || (m.author as { bot?: boolean }).bot) return;
      const conf = cog.config.guild(guildId);
      if (!conf.get<boolean>('enabled')) return;
      if (conf.get<string[]>('ignoredChannels').includes(m.channel_id)) return;
      const parent = p().getChannel(m.channel_id)?.parent_id;
      if (parent && conf.get<string[]>('ignoredChannels').includes(parent)) return;
      const member = p().getMember(guildId, m.author.id);
      if (member?.roles?.some((r) => conf.get<string[]>('ignoredRoles').includes(r))) return;
      if (await cog.bot.isImmune(guildId, m.author.id)) return;
      const rules = rulesOf(guildId);
      const key = `${guildId}:${m.author.id}`;
      let hit: { rule: string; ids: Array<{ id: string; channel: string }> } | null = null;
      const staticRule = checkStatic(rules, m);
      if (staticRule) hit = { rule: staticRule, ids: [{ id: m.id, channel: m.channel_id }] };
      else hit = checkRate(rules, key, m);
      if (!hit || handling.has(key)) return;
      handling.add(key);
      try {
        recent.delete(key);
        await punish(guildId, m.author.id, hit.rule, rules[hit.rule]!, hit.ids, m.content ?? '');
      } finally {
        handling.delete(key);
      }
    });

    // ------------------------------------------------------------------ Befehle
    const ruleChoices = Object.keys(DEFAULT_RULES).map((r) => ({ name: r, value: r }));
    const updateRule = (ctx: CommandContext, name: string, patch: Partial<Rule>) =>
      cog.config.guild(ctx.guildId!).update<Record<string, Rule>>('rules', (all) => ({
        ...all,
        [name]: { ...DEFAULT_RULES[name]!, ...(all?.[name] ?? {}), ...patch } as Rule,
      }));

    const describeRule = (ctx: CommandContext, name: string, r: Rule): string => {
      const params = Object.entries(r)
        .filter(([k]) => !['enabled', 'action', 'duration'].includes(k))
        .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') || '–' : v}`)
        .join(' ');
      const action = ctx.t(`actions.${r.action}`) + (r.action === 'timeout' ? ` ${humanizeSeconds(r.duration)}` : '');
      return `${r.enabled ? '✅' : '❌'} **${ctx.t(`rules.${name}`)}** (\`${name}\`) → ${action}\n  \`${params}\``;
    };

    cog.group({
      name: 'automod',
      description: 'Automatische Moderation einrichten.',
      guildOnly: true,
      permissions: { level: 'admin', member: ['ManageGuild'] },
      run: async (ctx) => {
        const conf = cog.config.guild(ctx.guildId!);
        const rules = rulesOf(ctx.guildId!);
        await ctx.sendEmbed({
          title: ctx.t('statusTitle', { state: conf.get<boolean>('enabled') ? ctx.t('common.on') : ctx.t('common.off') }),
          description: Object.entries(rules)
            .map(([n, r]) => describeRule(ctx, n, r))
            .join('\n'),
          fields: [
            { name: ctx.t('logChannel'), value: conf.get<string | null>('logChannel') ? `<#${conf.get('logChannel')}>` : '–', inline: true },
            {
              name: ctx.t('ignored'),
              value:
                [...conf.get<string[]>('ignoredChannels').map((c) => `<#${c}>`), ...conf.get<string[]>('ignoredRoles').map((r) => `<@&${r}>`)].join(' ') || '–',
              inline: true,
            },
          ],
          footer: ctx.t('statusFooter'),
        });
      },
      subcommands: [
        {
          name: 'toggle',
          description: 'Automod für diesen Server an/aus.',
          options: [{ name: 'aktiv', description: 'an/aus', type: OptionType.Boolean, required: true }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('enabled', ctx.arg<boolean>('aktiv'));
            await ctx.reply(ctx.t(ctx.arg<boolean>('aktiv') ? 'enabled' : 'disabled'));
          },
        },
        {
          name: 'rule',
          description: 'Eine Regel an/aus schalten.',
          options: [
            { name: 'regel', description: 'Regel', type: OptionType.String, required: true, choices: ruleChoices },
            { name: 'aktiv', description: 'an/aus', type: OptionType.Boolean, required: true },
          ],
          run: async (ctx) => {
            updateRule(ctx, ctx.arg<string>('regel'), { enabled: ctx.arg<boolean>('aktiv') });
            await ctx.tick();
          },
        },
        {
          name: 'action',
          description: 'Aktion einer Regel festlegen (delete, warn, timeout, kick, ban).',
          options: [
            { name: 'regel', description: 'Regel', type: OptionType.String, required: true, choices: ruleChoices },
            { name: 'aktion', description: 'Aktion', type: OptionType.String, required: true, choices: ACTIONS.map((a) => ({ name: a, value: a })) },
            { name: 'dauer', description: 'Dauer bei timeout (z. B. 10m)', type: OptionType.String },
          ],
          examples: ['automod action spam timeout 15m', 'automod action links delete'],
          run: async (ctx) => {
            const raw = ctx.arg<string | undefined>('dauer');
            const duration = raw ? takeDuration(raw).seconds : undefined;
            if (raw && !duration) throw new UserError(ctx.t('badDuration'));
            updateRule(ctx, ctx.arg<string>('regel'), { action: ctx.arg<Action>('aktion'), ...(duration ? { duration } : {}) });
            await ctx.tick();
          },
        },
        {
          name: 'set',
          description: 'Parameter einer Regel ändern (z. B. max, seconds, percent, minLength).',
          options: [
            { name: 'regel', description: 'Regel', type: OptionType.String, required: true, choices: ruleChoices },
            { name: 'parameter', description: 'Parametername', type: OptionType.String, required: true },
            { name: 'wert', description: 'Zahl', type: OptionType.Integer, required: true, min_value: 1, max_value: 1000 },
          ],
          examples: ['automod set spam max 5', 'automod set spam seconds 10', 'automod set caps percent 80'],
          run: async (ctx) => {
            const name = ctx.arg<string>('regel');
            const param = ctx.arg<string>('parameter');
            const def = DEFAULT_RULES[name]!;
            if (['enabled', 'action', 'duration', 'allow'].includes(param) || typeof def[param] !== 'number') {
              const params = Object.entries(def).filter(([, v]) => typeof v === 'number').map(([k]) => k).filter((k) => k !== 'duration');
              throw new UserError(ctx.t('badParam', { params: params.join(', ') }));
            }
            updateRule(ctx, name, { [param]: ctx.arg<number>('wert') });
            await ctx.tick();
          },
        },
        {
          name: 'allowlink',
          description: 'Domains, die die Link-Regel erlaubt (hinzufügen/entfernen umschalten).',
          options: [{ name: 'domains', description: 'z. B. youtube.com', type: OptionType.String, required: true, variadic: true }],
          run: async (ctx) => {
            const current = (rulesOf(ctx.guildId!).links!.allow as string[]) ?? [];
            const set = new Set(current);
            for (const d of ctx.arg<string[]>('domains').map((x) => x.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, ''))) {
              if (set.has(d)) set.delete(d);
              else set.add(d);
            }
            updateRule(ctx, 'links', { allow: [...set].sort() });
            await ctx.reply(ctx.t('allowed', { domains: [...set].join(', ') || '–' }));
          },
        },
        {
          name: 'ignore',
          description: 'Kanal/Kategorie oder Rolle von Automod ausnehmen (umschalten).',
          options: [{ name: 'ziel', description: '#kanal oder @rolle', type: OptionType.String, required: true }],
          run: async (ctx) => {
            const raw = ctx.arg<string>('ziel');
            const conf = cog.config.guild(ctx.guildId!);
            const ch = /^<#(\d+)>$/.exec(raw)?.[1] ?? (ctx.guild?.channels.has(raw) ? raw : undefined);
            const role = /^<@&(\d+)>$/.exec(raw)?.[1] ?? (ctx.guild?.roles.has(raw) ? raw : undefined);
            const toggle = (key: 'ignoredChannels' | 'ignoredRoles', id: string) => {
              let added = false;
              conf.update<string[]>(key, (l) => {
                added = !l.includes(id);
                return added ? [...l, id] : l.filter((x) => x !== id);
              });
              return added;
            };
            if (ch) return ctx.reply(ctx.t(toggle('ignoredChannels', ch) ? 'ignoredAdded' : 'ignoredRemoved'));
            if (role) return ctx.reply(ctx.t(toggle('ignoredRoles', role) ? 'ignoredAdded' : 'ignoredRemoved'));
            throw new UserError(ctx.t('badIgnore'));
          },
        },
        {
          name: 'log',
          description: 'Log-Kanal für Automod (ohne Angabe: aus).',
          options: [{ name: 'kanal', description: 'Kanal', type: OptionType.Channel, channel_types: [0, 5] }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('logChannel', ctx.arg<{ id: string } | undefined>('kanal')?.id ?? null);
            await ctx.tick();
          },
        },
        {
          name: 'reset',
          description: 'Alle Regeln auf Standard zurücksetzen.',
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).clear('rules');
            await ctx.tick();
          },
        },
      ],
    });
  },
});
