import path from 'node:path';
import 'dotenv/config';

/** Laufzeit-Konfiguration aus Umgebungsvariablen (.env). Nichts davon ist hartcodiert. */
export interface Env {
  /** Basis-URL der Fluxer-Instanz (Web-App), z. B. https://chat.nebendahl.eu */
  baseUrl: string;
  /** REST-API-Basis ohne Version, z. B. https://chat.nebendahl.eu/api */
  apiBaseUrl: string;
  /** true, wenn FLUXER_API_BASE_URL explizit gesetzt wurde (dann gewinnt sie gegenüber der Discovery). */
  apiBaseUrlExplicit: boolean;
  /** API-Version, wird als /v{version} angehängt. */
  apiVersion: string;
  /** Instanz-Discovery über {baseUrl}/.well-known/fluxer verwenden. */
  discovery: boolean;
  token: string;
  prefix: string;
  ownerIds: string[];
  locale: string;
  timezone: string;
  dataDir: string;
  logLevel: string;
  logPretty: boolean;
  /** Nach so vielen Sekunden ohne Gateway-Verbindung beendet sich der Prozess (Docker startet neu). */
  watchdogSeconds: number;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'ja', 'on'].includes(value.trim().toLowerCase());
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const baseUrl = trimSlash(source.FLUXER_BASE_URL?.trim() || 'https://chat.nebendahl.eu');
  const explicitApi = source.FLUXER_API_BASE_URL?.trim();
  const apiBaseUrl = trimSlash(explicitApi || `${baseUrl}/api`);
  const timezone = source.TZ?.trim() || 'Europe/Berlin';
  // Zeitzone prozessweit setzen, damit Date/Intl und der Scheduler übereinstimmen.
  process.env.TZ = timezone;
  return {
    baseUrl,
    apiBaseUrl,
    apiBaseUrlExplicit: Boolean(explicitApi),
    apiVersion: (source.FLUXER_API_VERSION?.trim() || '1').replace(/^v/i, ''),
    discovery: bool(source.FLUXER_DISCOVERY, true),
    token: source.FLUXER_TOKEN?.trim() ?? '',
    prefix: source.BOT_PREFIX?.trim() || '!',
    ownerIds: (source.BOT_OWNER_IDS ?? '')
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean),
    locale: source.BOT_LOCALE?.trim() || 'de',
    timezone,
    dataDir: path.resolve(source.DATA_DIR?.trim() || './data'),
    logLevel: source.LOG_LEVEL?.trim() || 'info',
    logPretty: bool(source.LOG_PRETTY, false),
    watchdogSeconds: Number(source.WATCHDOG_SECONDS ?? 600) || 600,
  };
}
