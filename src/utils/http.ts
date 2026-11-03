/**
 * Kleine HTTP-Helfer für Cogs (externe APIs wie Twitch, AniList, Wechselkurse).
 * Mit Timeout, verständlichen Fehlern und neutralem User-Agent.
 */
export const USER_AGENT = 'fluxer-redbot (+https://github.com/mialwe12-bot/Fluxer_RedBot)';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`HTTP ${status} bei ${new URL(url).host}`);
    this.name = 'HttpError';
  }
}

export interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | URLSearchParams;
  json?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
}

async function doFetch(url: string, o: FetchOptions = {}): Promise<Response> {
  const signals = [AbortSignal.timeout(o.timeoutMs ?? 15_000)];
  if (o.signal) signals.push(o.signal);
  const headers: Record<string, string> = { 'user-agent': USER_AGENT, ...(o.headers ?? {}) };
  let body = o.body;
  if (o.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(o.json);
  }
  const res = await fetch(url, { method: o.method ?? (body ? 'POST' : 'GET'), headers, body, signal: AbortSignal.any(signals) });
  if (!res.ok) throw new HttpError(res.status, url, (await res.text().catch(() => '')).slice(0, 500));
  return res;
}

export async function fetchJson<T = unknown>(url: string, o: FetchOptions = {}): Promise<T> {
  const res = await doFetch(url, { ...o, headers: { accept: 'application/json', ...(o.headers ?? {}) } });
  return (await res.json()) as T;
}

export async function fetchText(url: string, o: FetchOptions = {}): Promise<string> {
  return (await doFetch(url, o)).text();
}

/** Lädt Binärdaten mit Größenlimit (Bytes). */
export async function fetchBuffer(url: string, maxBytes: number, o: FetchOptions = {}): Promise<{ data: Buffer; contentType: string }> {
  const res = await doFetch(url, o);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len && len > maxBytes) throw new Error(`Datei zu groß (${Math.round(len / 1e6)} MB)`);
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > maxBytes) throw new Error(`Datei zu groß (${Math.round(data.length / 1e6)} MB)`);
  return { data, contentType: res.headers.get('content-type') ?? 'application/octet-stream' };
}
