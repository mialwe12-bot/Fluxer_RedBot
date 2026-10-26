import { REST } from '@fluxerjs/rest';
import { WebSocketManager } from '@fluxerjs/ws';
import path from 'node:path';
import { Bot, EXIT_RESTART } from './bot.js';
import { openDatabase } from './db/database.js';
import { loadEnv, type Env } from './env.js';
import { getLogger, initLogger, type Logger } from './logger.js';
import { FluxerPlatform } from './platform/platform.js';
import type { RestLike } from './platform/types.js';

/**
 * Instanz-Discovery: GET {FLUXER_BASE_URL}/.well-known/fluxer liefert u. a. endpoints.api_public.
 * Ist FLUXER_API_BASE_URL explizit gesetzt, gewinnt diese (Abweichung wird geloggt).
 */
async function resolveApiBase(env: Env, log: Logger): Promise<string> {
  if (!env.discovery) return env.apiBaseUrl;
  const url = `${env.baseUrl}/.well-known/fluxer`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const doc = (await res.json()) as { endpoints?: { api_public?: string; api?: string; gateway?: string } };
    const discovered = (doc.endpoints?.api_public ?? doc.endpoints?.api)?.replace(/\/+$/, '');
    log.info({ url, endpoints: doc.endpoints }, 'Instanz-Discovery erfolgreich');
    if (!discovered) return env.apiBaseUrl;
    if (env.apiBaseUrlExplicit) {
      if (discovered !== env.apiBaseUrl) {
        log.warn({ configured: env.apiBaseUrl, discovered }, 'FLUXER_API_BASE_URL weicht von der Discovery ab – verwende die konfigurierte URL');
      }
      return env.apiBaseUrl;
    }
    return discovered;
  } catch (err) {
    log.warn({ err: (err as Error).message, url, fallback: env.apiBaseUrl }, 'Instanz-Discovery fehlgeschlagen – verwende FLUXER_API_BASE_URL');
    return env.apiBaseUrl;
  }
}

async function main(): Promise<void> {
  const env = loadEnv();
  const log = initLogger(env.logLevel, env.logPretty);
  if (!env.token) {
    log.fatal('FLUXER_TOKEN fehlt. Bitte in der .env eintragen (siehe README).');
    process.exit(2);
  }

  // Ein Cog-Fehler darf den Bot nie crashen: unbehandelte Fehler nur loggen.
  process.on('unhandledRejection', (reason) => log.error({ err: reason }, 'Unbehandelte Promise-Ablehnung'));
  process.on('uncaughtException', (err) => log.error({ err }, 'Unbehandelte Ausnahme'));

  const apiBase = await resolveApiBase(env, log);
  log.info({ instance: env.baseUrl, api: `${apiBase}/v${env.apiVersion}`, tz: env.timezone }, 'Starte fluxer-redbot');

  const rest = new REST({ api: apiBase, version: env.apiVersion, authPrefix: 'Bot', retries: 3, timeout: 20_000, locale: 'de-DE' });
  rest.setToken(env.token);
  // Die Gateway-URL kommt unverändert aus GET /gateway/bot (keine Umschreibung ws→wss).
  const gateway = new WebSocketManager({
    token: env.token,
    rest,
    version: env.apiVersion,
    debug: env.logLevel === 'trace',
  });

  const platform = new FluxerPlatform({ rest: rest as unknown as RestLike, gateway, logger: getLogger('platform') });
  // Bot-Tokens haben die Form {application_id}.{secret}
  const appId = env.token.split('.')[0];
  if (appId && /^\d+$/.test(appId)) platform.applicationId = appId;

  const db = openDatabase(path.join(env.dataDir, 'bot.sqlite'));
  const bot = new Bot({ env, platform, db, logger: log });

  const stop = (signal: string) => {
    log.info({ signal }, 'Signal empfangen');
    void bot.shutdown(0);
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));
  bot.exit = (code) => {
    // Kurz warten, damit Logs geschrieben werden
    setTimeout(() => process.exit(code), 250);
  };

  await bot.init();
  await bot.connect();
  if (bot.platform.applicationId) {
    log.info({ invite: bot.inviteUrl() }, 'Einladungslink');
  }
}

main().catch((err) => {
  getLogger().fatal({ err }, 'Start fehlgeschlagen');
  setTimeout(() => process.exit(1), 250);
});

export { EXIT_RESTART };
