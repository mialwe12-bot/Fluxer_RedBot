import type { FluxerPlatform } from '../platform/platform.js';
import type { APIEmbed, APIMessage, MessagePayload } from '../platform/types.js';

/**
 * Reaktions-basierte Menüs als Ersatz für Buttons/Select-Menüs (die Fluxer noch nicht hat).
 */
export interface ReactionEvent {
  message_id: string;
  channel_id: string;
  user_id: string;
  guild_id?: string;
  emoji: { id?: string | null; name?: string | null };
}

interface Waiter {
  filter: (e: ReactionEvent) => boolean;
  onReact: (e: ReactionEvent) => void;
}

export const NUMBER_EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
export const EMOJI = {
  first: '⏮️',
  prev: '⬅️',
  stop: '⏹️',
  next: '➡️',
  last: '⏭️',
  yes: '✅',
  no: '❌',
} as const;

/** Vergleich unabhängig vom Variation-Selector (U+FE0F), den Clients unterschiedlich senden. */
export function sameEmoji(a: string, b: { id?: string | null; name?: string | null }): boolean {
  const strip = (s: string) => s.replace(/️/g, '');
  if (b.id) return a.includes(b.id);
  return strip(a) === strip(b.name ?? '');
}

/** Verteilt MESSAGE_REACTION_ADD an wartende Menüs. */
export class ReactionCollector {
  private readonly waiters = new Map<string, Set<Waiter>>();

  constructor(private readonly platform: FluxerPlatform) {
    platform.on('MESSAGE_REACTION_ADD', (d: ReactionEvent) => this.dispatch(d));
  }

  private dispatch(e: ReactionEvent): void {
    if (e.user_id === this.platform.user?.id) return;
    const set = this.waiters.get(e.message_id);
    if (!set) return;
    for (const w of [...set]) {
      try {
        if (w.filter(e)) w.onReact(e);
      } catch {
        /* Menü-Fehler dürfen den Bot nicht stören */
      }
    }
  }

  /** Ruft onReact für jede passende Reaktion auf, bis stop() oder Timeout. */
  collect(messageId: string, filter: (e: ReactionEvent) => boolean, timeoutMs: number, onReact: (e: ReactionEvent) => void, onEnd?: () => void): () => void {
    const waiter: Waiter = { filter, onReact };
    let set = this.waiters.get(messageId);
    if (!set) this.waiters.set(messageId, (set = new Set()));
    set.add(waiter);
    let ended = false;
    const timer = setTimeout(() => stop(), timeoutMs);
    timer.unref();
    const stop = () => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      set!.delete(waiter);
      if (set!.size === 0) this.waiters.delete(messageId);
      onEnd?.();
    };
    return stop;
  }

  /** Wartet auf genau eine passende Reaktion (oder null nach Timeout). */
  wait(messageId: string, filter: (e: ReactionEvent) => boolean, timeoutMs: number): Promise<ReactionEvent | null> {
    return new Promise((resolve) => {
      let result: ReactionEvent | null = null;
      const stop = this.collect(
        messageId,
        filter,
        timeoutMs,
        (e) => {
          result = e;
          stop();
        },
        () => resolve(result),
      );
    });
  }
}

export type Page = string | APIEmbed;

export interface MenuDeps {
  platform: FluxerPlatform;
  collector: ReactionCollector;
  /** Wandelt eine Seite in eine sendbare Nutzlast (Embed oder Text-Fallback). */
  render: (page: Page, index: number, total: number) => Promise<MessagePayload>;
}

async function addReactions(platform: FluxerPlatform, message: APIMessage, emojis: string[]): Promise<void> {
  for (const e of emojis) {
    try {
      await platform.addReaction(message.channel_id, message.id, e);
    } catch {
      return; // fehlendes Recht "Reaktionen hinzufügen" – Menü funktioniert dann nur eingeschränkt
    }
  }
}

/** Blättern mit ⬅️/➡️ (und ⏮️/⏭️ ab 5 Seiten), ⏹️ beendet. Nur der Aufrufer darf blättern. */
export async function paginate(
  deps: MenuDeps,
  channelId: string,
  userId: string,
  pages: Page[],
  options: { timeoutMs?: number; reply?: MessagePayload['message_reference'] } = {},
): Promise<APIMessage | undefined> {
  if (pages.length === 0) return undefined;
  const first = await deps.render(pages[0]!, 0, pages.length);
  const message = await deps.platform.sendMessage(channelId, { ...first, ...(options.reply ? { message_reference: options.reply } : {}) });
  if (pages.length === 1) return message;
  const controls = pages.length >= 5 ? [EMOJI.first, EMOJI.prev, EMOJI.stop, EMOJI.next, EMOJI.last] : [EMOJI.prev, EMOJI.stop, EMOJI.next];
  void addReactions(deps.platform, message, controls);
  let index = 0;
  const stop = deps.collector.collect(
    message.id,
    (e) => e.user_id === userId && controls.some((c) => sameEmoji(c, e.emoji)),
    options.timeoutMs ?? 120_000,
    (e) => {
      const emoji = controls.find((c) => sameEmoji(c, e.emoji))!;
      void deps.platform.removeReaction(message.channel_id, message.id, emoji, e.user_id).catch(() => undefined);
      if (emoji === EMOJI.stop) return stop();
      if (emoji === EMOJI.prev) index = (index - 1 + pages.length) % pages.length;
      if (emoji === EMOJI.next) index = (index + 1) % pages.length;
      if (emoji === EMOJI.first) index = 0;
      if (emoji === EMOJI.last) index = pages.length - 1;
      void deps
        .render(pages[index]!, index, pages.length)
        .then((payload) => deps.platform.editMessage(message.channel_id, message.id, payload))
        .catch(() => undefined);
    },
    () => void deps.platform.removeAllReactions(message.channel_id, message.id).catch(() => undefined),
  );
  return message;
}

/** Ja/Nein-Abfrage per ✅/❌. Liefert true, false oder null (Timeout). */
export async function confirm(
  deps: MenuDeps,
  channelId: string,
  userId: string,
  question: Page,
  timeoutMs = 60_000,
): Promise<boolean | null> {
  const message = await deps.platform.sendMessage(channelId, await deps.render(question, 0, 1));
  void addReactions(deps.platform, message, [EMOJI.yes, EMOJI.no]);
  const e = await deps.collector.wait(
    message.id,
    (r) => r.user_id === userId && (sameEmoji(EMOJI.yes, r.emoji) || sameEmoji(EMOJI.no, r.emoji)),
    timeoutMs,
  );
  void deps.platform.removeAllReactions(message.channel_id, message.id).catch(() => undefined);
  if (!e) return null;
  return sameEmoji(EMOJI.yes, e.emoji);
}

/**
 * Auswahl per Zahlen-Reaktion (1️⃣–🔟). `page` sollte die nummerierten Optionen bereits enthalten.
 * Liefert den Index (0-basiert) oder null.
 */
export async function choose(
  deps: MenuDeps,
  channelId: string,
  userId: string,
  page: Page,
  count: number,
  timeoutMs = 60_000,
): Promise<number | null> {
  const n = Math.min(count, NUMBER_EMOJIS.length);
  if (n === 0) return null;
  const emojis = NUMBER_EMOJIS.slice(0, n);
  const message = await deps.platform.sendMessage(channelId, await deps.render(page, 0, 1));
  void addReactions(deps.platform, message, [...emojis, EMOJI.no]);
  const e = await deps.collector.wait(
    message.id,
    (r) => r.user_id === userId && [...emojis, EMOJI.no].some((x) => sameEmoji(x, r.emoji)),
    timeoutMs,
  );
  void deps.platform.removeAllReactions(message.channel_id, message.id).catch(() => undefined);
  if (!e || sameEmoji(EMOJI.no, e.emoji)) return null;
  const idx = emojis.findIndex((x) => sameEmoji(x, e.emoji));
  return idx >= 0 ? idx : null;
}
