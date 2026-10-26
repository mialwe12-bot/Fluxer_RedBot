import type { Bot } from '../bot.js';
import { missingPermissions, PermissionLabels } from '../platform/permissionBits.js';
import type { APIMessage, APIUser } from '../platform/types.js';
import { humanizeSeconds } from '../utils/format.js';
import { CommandContext } from './context.js';
import { BotMissingPermissions, CheckFailure, CooldownError } from './errors.js';
import { parseArgs, usageOf, type ParseEnvironment } from './parser.js';
import type { Command } from './types.js';
import type { CheckSubject } from '../permissions/permissions.js';

/** Payload des Bot-Events 'commandNotFound' (für alias/customcom-Cogs). */
export interface CommandNotFoundEvent {
  message: APIMessage;
  prefix: string;
  /** Text nach dem Prefix. */
  text: string;
  /** Wurde das Event von einem Listener behandelt? Listener setzen das auf true. */
  handled: boolean;
}

const LEVEL_KEYS: Record<string, string> = {
  mod: 'perm.levels.mod',
  admin: 'perm.levels.admin',
  guildowner: 'perm.levels.guildowner',
  owner: 'perm.levels.owner',
};

/** Erkennt Befehle in Nachrichten, prüft Rechte/Cooldowns, parst Argumente und führt aus. */
export class CommandDispatcher {
  constructor(private readonly bot: Bot) {}

  /** Liefert das verwendete Prefix oder undefined. Bot-Erwähnung zählt als Prefix. */
  findPrefix(content: string, guildId: string | undefined): string | undefined {
    const prefixes = [...this.bot.prefixesFor(guildId)];
    const botId = this.bot.platform.user?.id;
    if (botId) prefixes.push(`<@${botId}> `, `<@!${botId}> `, `<@${botId}>`, `<@!${botId}>`);
    prefixes.sort((a, b) => b.length - a.length);
    return prefixes.find((p) => p && content.startsWith(p));
  }

  async handleMessage(message: APIMessage): Promise<void> {
    const author = message.author as APIUser & { bot?: boolean; system?: boolean };
    if (!author || author.bot || author.system || message.webhook_id) return;
    if (author.id === this.bot.platform.user?.id) return;
    const content = message.content ?? '';
    const guildId = message.guild_id ?? undefined;
    const prefix = this.findPrefix(content, guildId);
    if (prefix === undefined) return;
    const text = content.slice(prefix.length).trim();
    if (!text) return;
    const resolved = this.bot.registry.resolve(text);
    if (!resolved) {
      const event: CommandNotFoundEvent = { message, prefix, text, handled: false };
      this.bot.events.emit('commandNotFound', event);
      return;
    }
    const { command, invokedWith, argString } = resolved;
    const cog = this.bot.cogs.loaded.get(command.cogName);
    const displayPrefix = prefix.startsWith('<@') ? `@${this.bot.platform.user?.username ?? 'Bot'} ` : prefix;
    const ctx = new CommandContext(this.bot, message, command, displayPrefix, invokedWith, argString, cog);
    await this.invoke(ctx);
  }

  /** Führt die Prüfungen und den Befehl aus. Wirft nie. */
  async invoke(ctx: CommandContext): Promise<void> {
    const command = ctx.command;
    const started = Date.now();
    try {
      if (command.guildOnly && !ctx.guildId) throw new CheckFailure('errors.guildOnly');
      if (command.dmOnly && ctx.guildId) throw new CheckFailure('errors.dmOnly');

      const subject = this.subjectFor(ctx);
      const result = await this.bot.permissions.check(command, subject);
      if (!result.allowed) {
        if (result.reason === 'rule') throw new CheckFailure('errors.perm.denied');
        const levelKey = LEVEL_KEYS[result.required ?? 'mod'] ?? 'perm.levels.mod';
        const alt = command.permissions?.member;
        throw new CheckFailure(alt?.length ? 'errors.perm.levelOrPerms' : 'errors.perm.level', {
          level: ctx.t(levelKey),
          perms: (alt ?? []).map((p) => PermissionLabels[p]).join(', '),
        });
      }

      if (command.permissions?.bot?.length && ctx.guildId) {
        const bits = await this.bot.platform.botPermissions(ctx.guildId, ctx.channelId);
        const missing = missingPermissions(bits, command.permissions.bot);
        if (missing.length) {
          throw new BotMissingPermissions('errors.botMissing', { perms: missing.map((p) => PermissionLabels[p]).join(', ') });
        }
      }

      // Gruppe ohne eigenen Handler → Hilfe zur Gruppe
      if (command.children.size > 0 && !command.run) {
        if (ctx.argString) {
          await ctx.reply(ctx.t('errors.unknownSubcommand', { sub: ctx.argString.split(/\s+/)[0], command: command.qualifiedName }));
        }
        await this.bot.help.sendCommandHelp(ctx, command);
        return;
      }

      if (command.cooldown && !this.bot.isOwner(ctx.author.id)) {
        const wait = this.bot.cooldowns.hit(command.qualifiedName, command.cooldown, {
          userId: ctx.author.id,
          guildId: ctx.guildId,
          channelId: ctx.channelId,
        });
        if (wait > 0) throw new CooldownError(wait);
      }

      ctx.args = parseArgs(command.options ?? [], ctx.argString, this.parseEnv(ctx));
      await command.run!(ctx);
      this.bot.events.emit('commandCompleted', ctx, Date.now() - started);
    } catch (err) {
      await this.handleError(ctx, err);
    }
  }

  private subjectFor(ctx: CommandContext): CheckSubject {
    const channel = ctx.guildId ? this.bot.platform.getChannel(ctx.channelId) : undefined;
    const voice = ctx.guildId ? this.bot.platform.getVoiceState(ctx.guildId, ctx.author.id) : undefined;
    return {
      userId: ctx.author.id,
      guildId: ctx.guildId,
      channelId: ctx.channelId,
      categoryId: channel?.parent_id ?? null,
      voiceChannelId: voice?.channel_id ?? null,
    };
  }

  private parseEnv(ctx: CommandContext): ParseEnvironment {
    const users = new Map(this.bot.platform.users);
    for (const u of ctx.message.mentions ?? []) users.set(u.id, u);
    return {
      guild: ctx.guild,
      users,
      attachments: (ctx.message.attachments ?? []).map((a) => ({
        id: a.id,
        filename: a.filename,
        url: a.url ?? '',
        size: a.size,
        content_type: a.content_type ?? null,
      })),
    };
  }

  /** Lesbare Fehlermeldungen; unerwartete Fehler werden geloggt und für `!traceback` gemerkt. */
  async handleError(ctx: CommandContext, err: unknown): Promise<void> {
    // Hinweis: Cogs bündeln das SDK selbst, daher Fehlerklassen am Namen erkennen, nicht per instanceof.
    const e = err as { name?: string; key?: string; vars?: Record<string, string | number>; message?: string; retryAfterSeconds?: number };
    let text: string | undefined;
    try {
      switch (e?.name) {
        case 'ArgumentError': {
          const usage = `${ctx.prefix}${ctx.command.qualifiedName} ${usageOf(ctx.command.options)}`.trim();
          text = `❌ ${ctx.t(e.key!, e.vars)}\n${ctx.t('errors.usage', { usage })}\n${ctx.t('errors.helpHint', { prefix: ctx.prefix, command: ctx.command.qualifiedName })}`;
          break;
        }
        case 'CooldownError':
          text = `⏳ ${ctx.t('errors.cooldown', { time: humanizeSeconds(e.retryAfterSeconds ?? 1) })}`;
          break;
        case 'CheckFailure':
        case 'BotMissingPermissions':
        case 'CommandError':
        case 'CogError':
          text = `⛔ ${ctx.t(e.key!, e.vars)}`;
          break;
        case 'UserError':
        case 'VoiceUnsupportedError':
          text = `❌ ${e.message}`;
          break;
        default: {
          const id = Math.random().toString(36).slice(2, 8).toUpperCase();
          this.bot.log.error({ err, command: ctx.command.qualifiedName, errorId: id, cog: ctx.command.cogName }, 'Fehler beim Ausführen eines Befehls');
          this.bot.recordError(ctx.command.qualifiedName, err, id);
          text = `💥 ${ctx.t('errors.unexpected', { id })}`;
          this.bot.events.emit('commandError', ctx, err);
        }
      }
      if (text) await ctx.reply(text);
    } catch (sendErr) {
      this.bot.log.warn({ err: sendErr, original: err }, 'Fehlermeldung konnte nicht gesendet werden');
    }
  }
}

export { usageOf };
export type { Command };
