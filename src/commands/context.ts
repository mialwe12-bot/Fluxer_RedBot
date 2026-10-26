import type { Bot } from '../bot.js';
import type { Cog } from '../cogs/cog.js';
import type { Vars } from '../i18n/i18n.js';
import type { APIEmbed, APIGuildMember, APIMessage, APIUser, CachedGuild, MessagePayload } from '../platform/types.js';
import { embed as buildEmbed, type EmbedInput } from '../utils/embeds.js';
import type { Page } from '../utils/menus.js';
import type { Command, ParsedArgs } from './types.js';

export type Sendable = string | APIEmbed | EmbedInput | MessagePayload;

function isEmbedLike(v: unknown): v is APIEmbed | EmbedInput {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if ('content' in o || 'embeds' in o || 'files' in o) return false;
  return 'title' in o || 'description' in o || 'fields' in o || 'type' in o || 'image' in o || 'author' in o;
}

/** Kontext eines Befehlsaufrufs: Nachricht, Argumente und Antwort-Helfer. */
export class CommandContext {
  /** Geparste Argumente (Name der Option → Wert). */
  args: ParsedArgs = {};

  constructor(
    readonly bot: Bot,
    readonly message: APIMessage,
    readonly command: Command,
    readonly prefix: string,
    readonly invokedWith: string,
    readonly argString: string,
    readonly cog: Cog | undefined,
  ) {}

  get author(): APIUser {
    return this.message.author;
  }
  get guildId(): string | undefined {
    return this.message.guild_id ?? undefined;
  }
  get channelId(): string {
    return this.message.channel_id;
  }
  get guild(): CachedGuild | undefined {
    return this.guildId ? this.bot.platform.getGuild(this.guildId) : undefined;
  }
  get member(): APIGuildMember | undefined {
    return this.guildId ? this.bot.platform.getMember(this.guildId, this.author.id) : undefined;
  }
  get isDM(): boolean {
    return !this.guildId;
  }
  /** Typisierter Zugriff auf ein Argument. */
  arg<T = unknown>(name: string): T {
    return this.args[name] as T;
  }

  /** Übersetzung (Cog-Texte, dann Kern) in der Sprache der Guild. */
  t(key: string, vars?: Vars): string {
    const namespaces = this.cog ? [`cog:${this.cog.name}`, 'core'] : ['core'];
    return this.bot.i18n.t(namespaces, key, vars, this.bot.localeFor(this.guildId));
  }

  /** Wandelt Text/Embed/Payload in eine sendbare Nutzlast (inkl. Embed-Fallback). */
  async toPayload(content: Sendable): Promise<MessagePayload> {
    let payload: MessagePayload;
    if (typeof content === 'string') payload = { content };
    else if (isEmbedLike(content)) {
      const e = 'type' in content && content.type ? (content as APIEmbed) : buildEmbed(content as EmbedInput);
      payload = { embeds: [e] };
    } else payload = { ...(content as MessagePayload) };
    return this.bot.adaptPayload(payload, this.guildId, this.channelId);
  }

  /** Sendet in den Kanal. Lange Texte werden automatisch auf mehrere Nachrichten verteilt. */
  async send(content: Sendable): Promise<APIMessage> {
    return this.bot.send(this.channelId, await this.toPayload(content), this.guildId);
  }

  /** Antwortet mit Bezug auf die Befehlsnachricht. */
  async reply(content: Sendable): Promise<APIMessage> {
    const payload = await this.toPayload(content);
    payload.message_reference = { message_id: this.message.id, channel_id: this.channelId, fail_if_not_exists: false };
    payload.allowed_mentions ??= { parse: ['users'], replied_user: false };
    return this.bot.send(this.channelId, payload, this.guildId);
  }

  /** Sendet ein Embed (mit automatischem Text-Fallback). */
  async sendEmbed(input: EmbedInput | APIEmbed, extra: Omit<MessagePayload, 'embeds'> = {}): Promise<APIMessage> {
    const e = 'type' in input && input.type ? (input as APIEmbed) : buildEmbed(input as EmbedInput);
    return this.bot.send(this.channelId, await this.bot.adaptPayload({ ...extra, embeds: [e] }, this.guildId, this.channelId), this.guildId);
  }

  /** Erfolg ✅ / Fehler ❌ als Reaktion (oder Text, falls Reaktionen nicht gehen). */
  async react(emoji: string): Promise<void> {
    try {
      await this.bot.platform.addReaction(this.channelId, this.message.id, emoji);
    } catch {
      await this.send(emoji);
    }
  }
  async tick(): Promise<void> {
    await this.react('✅');
  }

  async typing(): Promise<void> {
    await this.bot.platform.triggerTyping(this.channelId).catch(() => undefined);
  }

  /** Direktnachricht an den Aufrufer. */
  async dm(content: Sendable): Promise<APIMessage> {
    const channelId = await this.bot.platform.createDM(this.author.id);
    return this.bot.send(channelId, await this.toPayload(content));
  }

  /** Seiten zum Blättern per Reaktion (⬅️ ➡️). */
  async paginate(pages: Page[], timeoutMs?: number): Promise<APIMessage | undefined> {
    return this.bot.menus.paginate(this.channelId, this.author.id, pages, this.guildId, timeoutMs);
  }

  /** Ja/Nein-Abfrage (✅/❌). */
  async confirm(question: Page, timeoutMs?: number): Promise<boolean | null> {
    return this.bot.menus.confirm(this.channelId, this.author.id, question, this.guildId, timeoutMs);
  }

  /** Auswahl 1–10 per Zahlen-Reaktion. Liefert Index oder null. */
  async choose(page: Page, count: number, timeoutMs?: number): Promise<number | null> {
    return this.bot.menus.choose(this.channelId, this.author.id, page, count, this.guildId, timeoutMs);
  }

  /** Hilfe zum aktuellen Befehl senden. */
  async sendHelp(): Promise<void> {
    await this.bot.help.sendCommandHelp(this, this.command);
  }
}
