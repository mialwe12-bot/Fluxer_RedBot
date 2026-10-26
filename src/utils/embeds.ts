import type { APIEmbed } from '../platform/types.js';

export const Colors = {
  default: 0x5865f2,
  success: 0x2ecc71,
  error: 0xe74c3c,
  warning: 0xf1c40f,
  info: 0x3498db,
} as const;

export interface EmbedInput {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  timestamp?: Date | string;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: string | { text: string; icon_url?: string };
  author?: string | { name: string; url?: string; icon_url?: string };
  thumbnail?: string;
  image?: string;
}

const LIMITS = { title: 256, description: 4096, fieldName: 256, fieldValue: 1024, footer: 2048, author: 256, fields: 25 };

function cut(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Baut ein Embed im Fluxer-/Discord-Format und hält die Längenlimits ein. */
export function embed(input: EmbedInput): APIEmbed {
  const e: Record<string, unknown> = { type: 'rich', color: input.color ?? Colors.default };
  if (input.title) e.title = cut(input.title, LIMITS.title);
  if (input.description) e.description = cut(input.description, LIMITS.description);
  if (input.url) e.url = input.url;
  if (input.timestamp) e.timestamp = new Date(input.timestamp).toISOString();
  if (input.fields?.length) {
    e.fields = input.fields.slice(0, LIMITS.fields).map((f) => ({
      name: cut(f.name || '​', LIMITS.fieldName),
      value: cut(f.value || '​', LIMITS.fieldValue),
      inline: f.inline ?? false,
    }));
  }
  if (input.footer) {
    const f = typeof input.footer === 'string' ? { text: input.footer } : input.footer;
    e.footer = { ...f, text: cut(f.text, LIMITS.footer) };
  }
  if (input.author) {
    const a = typeof input.author === 'string' ? { name: input.author } : input.author;
    e.author = { ...a, name: cut(a.name, LIMITS.author) };
  }
  if (input.thumbnail) e.thumbnail = { url: input.thumbnail };
  if (input.image) e.image = { url: input.image };
  return e as unknown as APIEmbed;
}

/** Text-Fallback für ein Embed (wenn Embeds deaktiviert sind oder das Recht fehlt). */
export function embedToText(e: APIEmbed): string {
  const lines: string[] = [];
  if (e.author?.name) lines.push(`_${e.author.name}_`);
  if (e.title) lines.push(`**${e.title}**${e.url ? ` <${e.url}>` : ''}`);
  if (e.description) lines.push(e.description);
  for (const f of e.fields ?? []) {
    lines.push('');
    lines.push(`**${f.name}**`);
    lines.push(f.value);
  }
  if (e.image?.url) lines.push(e.image.url);
  if (e.footer?.text || e.timestamp) {
    lines.push('');
    const parts = [e.footer?.text, e.timestamp ? new Date(e.timestamp).toLocaleString('de-DE') : undefined].filter(Boolean);
    lines.push(`-# ${parts.join(' • ')}`);
  }
  return lines.join('\n');
}
