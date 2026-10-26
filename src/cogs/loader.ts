import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import type { Bot } from '../bot.js';
import type { CogDefinition, CogManifest } from '../sdk/index.js';
import { Cog } from './cog.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Projektwurzel (eine Ebene über src/ bzw. dist/). */
export const APP_ROOT = path.resolve(HERE, '..', '..');
const RUNNING_FROM_SOURCE = import.meta.url.endsWith('.ts');
const SDK_ENTRY = RUNNING_FROM_SOURCE
  ? path.join(APP_ROOT, 'src', 'sdk', 'index.ts')
  : path.join(APP_ROOT, 'dist', 'sdk', 'index.js');
const NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const SETUP_TIMEOUT_MS = 30_000;

export class CogError extends Error {
  constructor(
    readonly key: string,
    readonly vars: Record<string, string | number> = {},
    options?: { cause?: unknown },
  ) {
    super(key, options);
    this.name = 'CogError';
  }
}

export interface CogInfo {
  name: string;
  dir: string;
  manifest: CogManifest;
  source: 'installed' | 'builtin';
}

export interface CogLoaderOptions {
  /** Suchpfade, in Prioritätsreihenfolge (frühere überschreiben spätere). */
  paths: Array<{ dir: string; source: 'installed' | 'builtin' }>;
  /** Wohin gebündelte Cogs geschrieben werden (muss unterhalb von APP_ROOT liegen, damit Pakete auflösbar sind). */
  cacheDir: string;
  /** Zusätzliche node_modules-Verzeichnisse für Cog-Abhängigkeiten (Downloader). */
  extraNodePaths?: string[];
}

/** Liest und prüft manifest.json. */
export function readManifest(dir: string): CogManifest {
  const file = path.join(dir, 'manifest.json');
  if (!fs.existsSync(file)) throw new CogError('cogs.errors.noManifest', { dir });
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new CogError('cogs.errors.badManifest', { dir, reason: (err as Error).message });
  }
  const m = raw as Partial<CogManifest>;
  const problems: string[] = [];
  if (typeof m.name !== 'string' || !NAME_RE.test(m.name)) problems.push('name');
  if (typeof m.version !== 'string') problems.push('version');
  if (typeof m.description !== 'string') problems.push('description');
  if (typeof m.author !== 'string' && !Array.isArray(m.author)) problems.push('author');
  if (m.dependencies !== undefined && (!Array.isArray(m.dependencies) || m.dependencies.some((d) => typeof d !== 'string'))) {
    problems.push('dependencies');
  }
  if (problems.length) throw new CogError('cogs.errors.badManifest', { dir, reason: `ungültige Felder: ${problems.join(', ')}` });
  if (m.name !== path.basename(dir)) {
    throw new CogError('cogs.errors.badManifest', { dir, reason: `name "${m.name}" passt nicht zum Ordner "${path.basename(dir)}"` });
  }
  return m as CogManifest;
}

function entryFile(dir: string): string | undefined {
  for (const f of ['index.ts', 'index.mts', 'index.js', 'index.mjs']) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

/** Externe Pakete = Abhängigkeiten des Bots selbst (werden aus APP_ROOT/node_modules geladen). */
function botDependencies(): string[] {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    return Object.keys(pkg.dependencies ?? {});
  } catch {
    return [];
  }
}

/**
 * Lädt, entlädt und lädt Cogs zur Laufzeit neu.
 *
 * Jeder Cog wird beim Laden mit esbuild zu einer einzelnen ESM-Datei gebündelt und per
 * dynamischem import() geladen. Da jede Ladung eine neue Datei ist, greift der ESM-Cache nicht –
 * so funktioniert Hot-Reload inklusive aller Untermodule eines Cogs.
 */
export class CogLoader {
  readonly loaded = new Map<string, Cog>();
  private readonly definitions = new Map<string, CogDefinition>();
  private readonly externals = botDependencies();
  /** Gerade ladende Cogs (Zyklus-Erkennung). */
  private readonly loading = new Set<string>();

  constructor(
    private readonly bot: Bot,
    private readonly options: CogLoaderOptions,
  ) {
    fs.mkdirSync(options.cacheDir, { recursive: true });
    // Reste früherer Läufe entfernen
    for (const f of fs.readdirSync(options.cacheDir)) {
      if (f.endsWith('.mjs')) fs.rmSync(path.join(options.cacheDir, f), { force: true });
    }
  }

  /** Alle verfügbaren Cogs (installierte überschreiben mitgelieferte gleichen Namens). */
  discover(): Map<string, CogInfo> {
    const out = new Map<string, CogInfo>();
    for (const { dir, source } of [...this.options.paths].reverse()) {
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
        const cogDir = path.join(dir, entry.name);
        if (!fs.existsSync(path.join(cogDir, 'manifest.json'))) continue;
        try {
          const manifest = readManifest(cogDir);
          out.set(manifest.name, { name: manifest.name, dir: cogDir, manifest, source });
        } catch (err) {
          this.bot.log.warn({ err, dir: cogDir }, 'Cog mit fehlerhaftem Manifest übersprungen');
        }
      }
    }
    return out;
  }

  isLoaded(name: string): boolean {
    return this.loaded.has(name);
  }

  /** Geladene Cogs, die (direkt) von `name` abhängen. */
  dependentsOf(name: string): string[] {
    return [...this.loaded.values()]
      .filter((c) => (c.manifest.dependencies ?? []).includes(name))
      .map((c) => c.name);
  }

  /** Bündelt und importiert das Cog-Modul. */
  private async importModule(info: CogInfo): Promise<CogDefinition> {
    const entry = entryFile(info.dir);
    if (!entry) throw new CogError('cogs.errors.noEntry', { name: info.name });
    const outFile = path.join(this.options.cacheDir, `${info.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mjs`);
    try {
      await build({
        entryPoints: [entry],
        outfile: outFile,
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node22',
        sourcemap: 'inline',
        logLevel: 'silent',
        alias: { '@bot/sdk': SDK_ENTRY },
        external: this.externals,
        nodePaths: [path.join(APP_ROOT, 'node_modules'), ...(this.options.extraNodePaths ?? [])],
        absWorkingDir: info.dir,
        // CommonJS-Abhängigkeiten nutzen require() – in ESM-Bundles nachrüsten.
        banner: {
          js: "import { createRequire as __cogCreateRequire } from 'node:module'; const require = __cogCreateRequire(import.meta.url);",
        },
      });
    } catch (err) {
      const errors = (err as { errors?: Array<{ text: string; location?: { file: string; line: number } }> }).errors;
      const reason = errors?.length
        ? errors
            .slice(0, 3)
            .map((e) => `${e.location ? `${path.relative(info.dir, e.location.file)}:${e.location.line}: ` : ''}${e.text}`)
            .join('; ')
        : (err as Error).message;
      throw new CogError('cogs.errors.build', { name: info.name, reason }, { cause: err });
    }
    try {
      const mod = (await import(pathToFileURL(outFile).href)) as { default?: unknown; cog?: unknown; setup?: unknown };
      const candidate = mod.default ?? mod.cog ?? (typeof mod.setup === 'function' ? { setup: mod.setup } : undefined);
      const def =
        typeof candidate === 'function'
          ? ({ setup: candidate } as CogDefinition)
          : (candidate as CogDefinition | undefined);
      if (!def || typeof def.setup !== 'function') throw new CogError('cogs.errors.noSetup', { name: info.name });
      return def;
    } finally {
      fs.rmSync(outFile, { force: true });
    }
  }

  /**
   * Lädt einen Cog (und fehlende Abhängigkeiten). Wirft CogError mit i18n-Schlüssel.
   * @returns zusätzlich geladene Abhängigkeiten
   */
  async load(name: string): Promise<string[]> {
    const loadedDeps: string[] = [];
    await this.loadInner(name.toLowerCase(), loadedDeps);
    return loadedDeps.filter((d) => d !== name.toLowerCase());
  }

  private async loadInner(name: string, loadedDeps: string[]): Promise<void> {
    if (this.loaded.has(name)) throw new CogError('cogs.errors.alreadyLoaded', { name });
    if (this.loading.has(name)) throw new CogError('cogs.errors.cycle', { name });
    const info = this.discover().get(name);
    if (!info) throw new CogError('cogs.errors.notFound', { name });
    this.loading.add(name);
    try {
      for (const dep of info.manifest.dependencies ?? []) {
        if (this.loaded.has(dep)) continue;
        try {
          await this.loadInner(dep, loadedDeps);
        } catch (err) {
          if (err instanceof CogError && err.key === 'cogs.errors.notFound') {
            throw new CogError('cogs.errors.missingDependency', { name, dependency: dep });
          }
          throw err;
        }
      }
      const definition = await this.importModule(info);
      await this.activate(info, definition);
      loadedDeps.push(name);
    } finally {
      this.loading.delete(name);
    }
  }

  /** Lädt einen fest eingebauten Cog (z. B. Core) ohne Dateisystem. */
  async loadInternal(manifest: CogManifest, definition: CogDefinition, dir = APP_ROOT): Promise<Cog> {
    return this.activate({ name: manifest.name, dir, manifest, source: 'builtin' }, definition, true);
  }

  private async activate(info: CogInfo, definition: CogDefinition, internal = false): Promise<Cog> {
    const bot = this.bot;
    const cog = new Cog(bot, info.manifest, info.dir, internal);
    bot.i18n.loadDirectory(`cog:${info.name}`, path.join(info.dir, 'locales'));
    try {
      await withTimeout(Promise.resolve(definition.setup(cog)), SETUP_TIMEOUT_MS, info.name);
      // Erst nach erfolgreichem setup() wird irgendetwas aktiv. Befehle zuerst (Konflikte → Abbruch).
      for (const def of cog.commandDefs) bot.registry.register(def, cog.name, cog.displayName);
    } catch (err) {
      bot.registry.unregisterCog(cog.name);
      bot.i18n.removeNamespace(`cog:${info.name}`);
      cog.abort();
      if (err instanceof CogError) throw err;
      throw new CogError('cogs.errors.setup', { name: info.name, reason: (err as Error)?.message ?? String(err) }, { cause: err });
    }
    cog.active = true;
    for (const l of cog.listeners) cog.attachListener(l);
    for (const t of cog.tasks) {
      try {
        bot.scheduler.add(`cog:${cog.name}`, t);
      } catch (err) {
        cog.log.error({ err, task: t.name }, 'Task konnte nicht geplant werden');
      }
    }
    this.loaded.set(cog.name, cog);
    this.definitions.set(cog.name, definition);
    if (bot.isReady) for (const hook of cog.readyHooks) void cog.runHook(hook, 'onReady');
    bot.events.emit('cogLoaded', cog.name);
    bot.log.info({ cog: cog.name, version: info.manifest.version }, 'Cog geladen');
    return cog;
  }

  /** Entlädt einen Cog. Wirft, wenn andere geladene Cogs davon abhängen (außer force). */
  async unload(name: string, options: { force?: boolean } = {}): Promise<void> {
    const key = name.toLowerCase();
    const cog = this.loaded.get(key);
    if (!cog) throw new CogError('cogs.errors.notLoaded', { name: key });
    if (cog.internal) throw new CogError('cogs.errors.internal', { name: key });
    const dependents = this.dependentsOf(key);
    if (dependents.length && !options.force) {
      throw new CogError('cogs.errors.hasDependents', { name: key, dependents: dependents.join(', ') });
    }
    const definition = this.definitions.get(key);
    try {
      if (definition?.teardown) await withTimeout(Promise.resolve(definition.teardown(cog)), SETUP_TIMEOUT_MS, key);
    } catch (err) {
      cog.log.error({ err }, 'Fehler in teardown() – Cog wird trotzdem entladen');
    }
    for (const hook of cog.unloadHooks) await cog.runHook(hook, 'onUnload');
    cog.detachListeners();
    this.bot.scheduler.removeOwner(`cog:${key}`);
    this.bot.registry.unregisterCog(key);
    this.bot.cooldowns.reset();
    this.bot.i18n.removeNamespace(`cog:${key}`);
    cog.active = false;
    cog.abort();
    this.loaded.delete(key);
    this.definitions.delete(key);
    this.bot.events.emit('cogUnloaded', key);
    this.bot.log.info({ cog: key }, 'Cog entladen');
  }

  /**
   * Lädt einen Cog neu. Abhängige Cogs werden vorher entladen und danach wieder geladen.
   * @returns die mit neu geladenen abhängigen Cogs
   */
  async reload(name: string): Promise<string[]> {
    const key = name.toLowerCase();
    const order = this.dependentClosure(key); // abhängige zuerst entladen
    for (const n of order) await this.unload(n, { force: true });
    if (this.loaded.has(key)) await this.unload(key, { force: true });
    await this.load(key);
    const reloaded: string[] = [];
    for (const n of [...order].reverse()) {
      if (this.loaded.has(n)) continue;
      try {
        await this.load(n);
        reloaded.push(n);
      } catch (err) {
        this.bot.log.error({ err, cog: n }, 'Abhängiger Cog konnte nach Reload nicht geladen werden');
      }
    }
    return reloaded;
  }

  /** Alle (transitiv) abhängigen geladenen Cogs, in Entlade-Reihenfolge (tiefste zuerst). */
  private dependentClosure(name: string): string[] {
    const result: string[] = [];
    const visit = (n: string) => {
      for (const d of this.dependentsOf(n)) {
        if (result.includes(d)) continue;
        visit(d);
        result.push(d);
      }
    };
    visit(name);
    return result;
  }

  /** Ruft bei Verbindungsaufbau die onReady-Hooks aller Cogs auf. */
  runReadyHooks(): void {
    for (const cog of this.loaded.values()) for (const hook of cog.readyHooks) void cog.runHook(hook, 'onReady');
  }

  /** Alle Cogs entladen (beim Herunterfahren). */
  async unloadAll(): Promise<void> {
    const names = [...this.loaded.keys()].filter((n) => !this.loaded.get(n)!.internal);
    // Abhängige zuerst: wer weniger (transitive) Abhängige hat, wird früher entladen.
    const ordered = names.sort((a, b) => this.dependentClosure(a).length - this.dependentClosure(b).length);
    for (const n of ordered) {
      if (!this.loaded.has(n)) continue;
      try {
        await this.unload(n, { force: true });
      } catch (err) {
        this.bot.log.warn({ err, cog: n }, 'Fehler beim Entladen');
      }
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CogError('cogs.errors.timeout', { name, seconds: ms / 1000 })), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
