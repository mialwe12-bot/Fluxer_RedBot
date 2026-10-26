/** Formatierungs-Helfer (angelehnt an Reds chat_formatting). */

export const MESSAGE_LIMIT = 2000;

export function bold(s: string): string {
  return `**${s}**`;
}
export function italic(s: string): string {
  return `*${s}*`;
}
export function inlineCode(s: string): string {
  return `\`${s.replace(/`/g, 'ˋ')}\``;
}
export function codeBlock(s: string, lang = ''): string {
  return `\`\`\`${lang}\n${s.replace(/```/g, 'ˋˋˋ')}\n\`\`\``;
}

/** Entfernt Massen-Erwähnungen und optional Markdown. */
export function escape(text: string, options: { mentions?: boolean; markdown?: boolean } = {}): string {
  let out = text;
  if (options.mentions !== false) out = out.replace(/@(everyone|here)/g, '@​$1');
  if (options.markdown) out = out.replace(/([*_~`|>\\])/g, '\\$1');
  return out;
}

/**
 * Teilt langen Text in Seiten (bevorzugt an Zeilenumbrüchen), wie Reds pagify().
 * `wrap` wird um jede Seite gelegt (z. B. Codeblock) und bei der Länge berücksichtigt.
 */
export function pagify(text: string, options: { pageLength?: number; delims?: string[]; wrap?: [string, string] } = {}): string[] {
  const wrap = options.wrap ?? ['', ''];
  const max = (options.pageLength ?? MESSAGE_LIMIT) - wrap[0].length - wrap[1].length;
  const delims = options.delims ?? ['\n', ' '];
  const pages: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = -1;
    for (const d of delims) {
      cut = rest.lastIndexOf(d, max);
      if (cut > max / 4) break;
    }
    if (cut <= 0) cut = max;
    pages.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest.trim().length) pages.push(rest);
  return pages.map((p) => `${wrap[0]}${p}${wrap[1]}`);
}

/** "a, b und c" */
export function humanList(items: string[], conj = 'und'): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} ${conj} ${items[items.length - 1]}`;
}

const UNITS: Array<[number, string, string]> = [
  [365 * 86400, 'Jahr', 'Jahre'],
  [30 * 86400, 'Monat', 'Monate'],
  [7 * 86400, 'Woche', 'Wochen'],
  [86400, 'Tag', 'Tage'],
  [3600, 'Stunde', 'Stunden'],
  [60, 'Minute', 'Minuten'],
  [1, 'Sekunde', 'Sekunden'],
];

/** 3725 → "1 Stunde, 2 Minuten und 5 Sekunden" */
export function humanizeSeconds(totalSeconds: number, maxUnits = 3): string {
  let s = Math.max(0, Math.round(totalSeconds));
  if (s === 0) return '0 Sekunden';
  const parts: string[] = [];
  for (const [size, one, many] of UNITS) {
    if (s >= size) {
      const n = Math.floor(s / size);
      s -= n * size;
      parts.push(`${n} ${n === 1 ? one : many}`);
      if (parts.length >= maxUnits) break;
    }
  }
  return humanList(parts);
}

const DURATION_UNITS: Record<string, number> = {
  s: 1, sek: 1, sec: 1, sekunde: 1, sekunden: 1, second: 1, seconds: 1,
  m: 60, min: 60, minute: 60, minuten: 60, minutes: 60,
  h: 3600, std: 3600, stunde: 3600, stunden: 3600, hour: 3600, hours: 3600,
  d: 86400, t: 86400, tag: 86400, tage: 86400, day: 86400, days: 86400,
  w: 604800, woche: 604800, wochen: 604800, week: 604800, weeks: 604800,
};

/** "1h30m", "2 tage", "45s", "10" (=Minuten, wenn defaultUnit='m') → Sekunden. undefined bei ungültig. */
export function parseDuration(input: string, defaultUnit: 's' | 'm' = 'm'): number | undefined {
  const text = input.trim().toLowerCase().replace(/,/g, '.');
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * (defaultUnit === 'm' ? 60 : 1));
  const re = /(\d+(?:\.\d+)?)\s*([a-zäöü]+)/g;
  let total = 0;
  let matched = '';
  for (const m of text.matchAll(re)) {
    const unit = DURATION_UNITS[m[2]!];
    if (unit === undefined) return undefined;
    total += Number(m[1]) * unit;
    matched += m[0];
  }
  if (!matched || matched.replace(/\s/g, '') !== text.replace(/\s/g, '')) return undefined;
  return Math.round(total);
}

/** Datum/Uhrzeit in der Bot-Zeitzone, deutsch formatiert. */
export function formatDateTime(date: Date | number, timeZone = process.env.TZ ?? 'Europe/Berlin'): string {
  return new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(date);
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat('de-DE').format(n);
}
