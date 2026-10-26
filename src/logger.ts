import { pino, type Logger } from 'pino';

export type { Logger };

let root: Logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

/** Initialisiert den Root-Logger (strukturiertes JSON, optional hübsch formatiert). */
export function initLogger(level: string, pretty: boolean): Logger {
  root = pino({
    level,
    base: { app: 'fluxer-redbot' },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:yyyy-mm-dd HH:MM:ss', ignore: 'pid,hostname,app' },
          },
        }
      : {}),
  });
  return root;
}

export function getLogger(name?: string): Logger {
  return name ? root.child({ module: name }) : root;
}

/** Logger, der nichts ausgibt (für Tests). */
export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}
