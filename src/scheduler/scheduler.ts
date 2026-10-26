import { Cron } from 'croner';
import type { Logger } from '../logger.js';
import { parseDuration } from '../utils/format.js';

/**
 * Zeitgesteuerte Aufgaben, Zeitzone Europe/Berlin (konfigurierbar).
 *   cog.schedule({ name: 'check', every: '15m', run: async () => … })
 *   cog.schedule({ name: 'daily', cron: '0 9 * * *', run: … })   // täglich 9:00 Uhr
 *   cog.schedule({ name: 'once', at: new Date(...), run: … })
 * Ein Durchlauf startet nicht, solange der vorherige noch läuft. Fehler werden geloggt, nie geworfen.
 */
export interface TaskSpec {
  name: string;
  /** Cron-Ausdruck (5 oder 6 Felder) in der Bot-Zeitzone. */
  cron?: string;
  /** Intervall: Sekunden oder Dauer wie "15m", "1h". */
  every?: number | string;
  /** Einmalig zu diesem Zeitpunkt. */
  at?: Date;
  /** Bei `every`: sofort einmal ausführen. */
  runOnStart?: boolean;
  run: (signal: AbortSignal) => unknown | Promise<unknown>;
}

export interface TaskInfo {
  owner: string;
  name: string;
  nextRun: Date | null;
  running: boolean;
  lastError: string | null;
}

interface TaskHandle {
  owner: string;
  spec: TaskSpec;
  running: boolean;
  lastError: string | null;
  controller: AbortController;
  cron?: Cron;
  timer?: NodeJS.Timeout;
  nextRun: Date | null;
  stopped: boolean;
}

export class Scheduler {
  private readonly tasks = new Set<TaskHandle>();

  constructor(
    readonly timezone: string,
    private readonly log: Logger,
  ) {}

  add(owner: string, spec: TaskSpec): () => void {
    const handle: TaskHandle = {
      owner,
      spec,
      running: false,
      lastError: null,
      controller: new AbortController(),
      nextRun: null,
      stopped: false,
    };
    const exec = () => this.execute(handle);
    if (spec.cron || spec.at) {
      handle.cron = new Cron(spec.cron ?? spec.at!, { timezone: this.timezone, catch: false, unref: true }, () => {
        void exec();
        handle.nextRun = handle.cron?.nextRun() ?? null;
      });
      handle.nextRun = handle.cron.nextRun();
    } else if (spec.every !== undefined) {
      const seconds = typeof spec.every === 'number' ? spec.every : parseDuration(spec.every, 's');
      if (!seconds || seconds < 1) throw new Error(`Ungültiges Intervall für Task ${owner}/${spec.name}: ${spec.every}`);
      const loop = () => {
        if (handle.stopped) return;
        handle.nextRun = new Date(Date.now() + seconds * 1000);
        handle.timer = setTimeout(async () => {
          await exec();
          loop();
        }, seconds * 1000);
        handle.timer.unref();
      };
      if (spec.runOnStart) void exec();
      loop();
    } else {
      throw new Error(`Task ${owner}/${spec.name} braucht cron, every oder at.`);
    }
    this.tasks.add(handle);
    return () => this.stop(handle);
  }

  private async execute(handle: TaskHandle): Promise<void> {
    if (handle.running || handle.stopped) {
      if (handle.running) this.log.debug({ task: handle.spec.name, owner: handle.owner }, 'Task läuft noch – Durchlauf übersprungen');
      return;
    }
    handle.running = true;
    try {
      await handle.spec.run(handle.controller.signal);
      handle.lastError = null;
    } catch (err) {
      handle.lastError = err instanceof Error ? err.message : String(err);
      this.log.error({ err, task: handle.spec.name, owner: handle.owner }, 'Geplanter Task fehlgeschlagen');
    } finally {
      handle.running = false;
    }
  }

  private stop(handle: TaskHandle): void {
    handle.stopped = true;
    handle.controller.abort();
    handle.cron?.stop();
    if (handle.timer) clearTimeout(handle.timer);
    this.tasks.delete(handle);
  }

  /** Stoppt alle Tasks eines Besitzers (z. B. beim Entladen eines Cogs). */
  removeOwner(owner: string): number {
    let n = 0;
    for (const h of [...this.tasks]) {
      if (h.owner === owner) {
        this.stop(h);
        n++;
      }
    }
    return n;
  }

  list(owner?: string): TaskInfo[] {
    return [...this.tasks]
      .filter((h) => !owner || h.owner === owner)
      .map((h) => ({ owner: h.owner, name: h.spec.name, nextRun: h.nextRun, running: h.running, lastError: h.lastError }));
  }

  stopAll(): void {
    for (const h of [...this.tasks]) this.stop(h);
  }
}
