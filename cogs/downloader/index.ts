import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  defineCog,
  embed,
  inlineCode,
  OptionType,
  pagify,
  UserError,
  formatDateTime,
  type Cog,
  type CogManifest,
  type CommandContext,
} from '@bot/sdk';

const run = promisify(execFile);

interface RepoEntry {
  url: string;
  branch: string | null;
  addedAt: string;
}
interface InstalledEntry {
  repo: string;
  commit: string;
  hash: string;
  installedAt: string;
}

const REPO_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/i;

/** Zugangsdaten in URLs maskieren (https://user:token@host → https://***@host). */
export function maskUrl(url: string): string {
  return url.replace(/\/\/[^/@\s]+@/, '//***@');
}

/** Nur sichere Git-Transporte zulassen (kein file://, ext::, -Optionen). */
export function isAllowedGitUrl(url: string): boolean {
  if (url.startsWith('-')) return false;
  return /^(https?:\/\/|ssh:\/\/|git@[\w.-]+:)/i.test(url) && !/^ext::/i.test(url);
}

async function git(args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await run('git', args, {
      cwd,
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
    });
    return stdout.trim();
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new UserError(maskUrl((e.stderr || e.message).trim().split('\n').slice(-3).join(' ')));
  }
}

/** Ordner mit manifest.json im Repo-Wurzelverzeichnis oder unter cogs/. */
function repoCogs(repoDir: string): Map<string, { dir: string; manifest: CogManifest }> {
  const out = new Map<string, { dir: string; manifest: CogManifest }>();
  for (const base of [repoDir, path.join(repoDir, 'cogs')]) {
    if (!fs.existsSync(base)) continue;
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const dir = path.join(base, entry.name);
      const file = path.join(dir, 'manifest.json');
      if (!fs.existsSync(file)) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as CogManifest;
        if (manifest.name === entry.name) out.set(manifest.name, { dir, manifest });
      } catch {
        /* fehlerhafte manifest.json ignorieren */
      }
    }
  }
  return out;
}

/** Inhalts-Hash eines Cog-Ordners (für Update-Erkennung, unabhängig von der Git-Historie). */
function dirHash(dir: string): string {
  const hash = createHash('sha256');
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else {
        hash.update(path.relative(dir, p));
        hash.update(fs.readFileSync(p));
      }
    }
  };
  walk(dir);
  return hash.digest('hex');
}

function copyDir(src: string, dest: string): void {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (p) => !p.split(path.sep).some((part) => part === '.git' || part === 'node_modules'),
  });
}

export default defineCog({
  setup(cog: Cog) {
    const dataDir = cog.bot.env.dataDir;
    const reposDir = path.join(dataDir, 'repos');
    const cogsDir = path.join(dataDir, 'cogs');
    const libsDir = path.join(dataDir, 'cog-libs');

    cog.config.registerGlobal({
      repos: {} as Record<string, RepoEntry>,
      installed: {} as Record<string, InstalledEntry>,
      warned: false,
    });
    const g = () => cog.config.global();
    const repos = () => g().get<Record<string, RepoEntry>>('repos');
    const installed = () => g().get<Record<string, InstalledEntry>>('installed');

    const repoDir = (name: string) => path.join(reposDir, name);
    const requireRepo = (ctx: CommandContext, name: string): RepoEntry => {
      const entry = repos()[name.toLowerCase()];
      if (!entry) throw new UserError(ctx.t('repo.notFound', { name }));
      return entry;
    };

    async function updateRepo(name: string): Promise<{ before: string; after: string }> {
      const entry = repos()[name]!;
      const dir = repoDir(name);
      if (!fs.existsSync(path.join(dir, '.git'))) {
        await clone(name, entry.url, entry.branch);
        const head = await git(['rev-parse', 'HEAD'], dir);
        return { before: '', after: head };
      }
      const before = await git(['rev-parse', 'HEAD'], dir);
      await git(['fetch', '--depth', '1', 'origin', entry.branch ?? 'HEAD'], dir);
      await git(['reset', '--hard', 'FETCH_HEAD'], dir);
      const after = await git(['rev-parse', 'HEAD'], dir);
      return { before, after };
    }

    async function clone(name: string, url: string, branch: string | null): Promise<void> {
      const dir = repoDir(name);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(reposDir, { recursive: true });
      const args = ['clone', '--depth', '1'];
      if (branch) args.push('--branch', branch);
      args.push('--', url, dir);
      await git(args);
    }

    async function installNpm(manifest: CogManifest): Promise<string[]> {
      const deps = Object.entries(manifest.npmDependencies ?? {});
      if (!deps.length) return [];
      fs.mkdirSync(libsDir, { recursive: true });
      if (!fs.existsSync(path.join(libsDir, 'package.json'))) {
        fs.writeFileSync(path.join(libsDir, 'package.json'), JSON.stringify({ name: 'cog-libs', private: true }, null, 2));
      }
      const specs = deps.map(([n, v]) => `${n}@${v}`);
      try {
        await run('npm', ['install', '--prefix', libsDir, '--no-audit', '--no-fund', '--omit=dev', ...specs], {
          timeout: 300_000,
          maxBuffer: 20 * 1024 * 1024,
        });
      } catch (err) {
        const e = err as { stderr?: string; message: string };
        throw new UserError(`npm: ${(e.stderr || e.message).trim().split('\n').slice(-3).join(' ')}`);
      }
      return specs;
    }

    async function installCog(repoName: string, cogName: string): Promise<{ npm: string[]; overridesBuiltin: boolean }> {
      const available = repoCogs(repoDir(repoName));
      const found = available.get(cogName);
      if (!found) throw new UserError(cog.t('cog.notInRepo', { cog: cogName, repo: repoName }));
      const builtin = cog.bot.cogs.discover().get(cogName);
      const overridesBuiltin = builtin?.source === 'builtin';
      const npm = await installNpm(found.manifest);
      copyDir(found.dir, path.join(cogsDir, cogName));
      const commit = await git(['rev-parse', 'HEAD'], repoDir(repoName)).catch(() => '');
      g().update<Record<string, InstalledEntry>>('installed', (all) => ({
        ...all,
        [cogName]: { repo: repoName, commit, hash: dirHash(found.dir), installedAt: new Date().toISOString() },
      }));
      return { npm, overridesBuiltin };
    }

    /** Einmalige Warnung wie bei Red: fremder Code läuft mit vollen Rechten. */
    async function ensureWarned(ctx: CommandContext): Promise<boolean> {
      if (g().get<boolean>('warned')) return true;
      const ok = await ctx.confirm(ctx.t('warning'));
      if (ok) g().set('warned', true);
      return ok === true;
    }

    // ------------------------------------------------------------------ repo
    cog.group({
      name: 'repo',
      description: cog.t('repo.description'),
      permissions: { level: 'owner' },
      subcommands: [
        {
          name: 'add',
          description: cog.t('repo.add.description'),
          options: [
            { name: 'name', description: cog.t('repo.add.name'), type: OptionType.String, required: true },
            { name: 'url', description: cog.t('repo.add.url'), type: OptionType.String, required: true },
            { name: 'branch', description: cog.t('repo.add.branch'), type: OptionType.String },
          ],
          examples: ['repo add meine https://git.example.de/ich/cogs.git', 'repo add privat https://user:token@forgejo.example.de/ich/cogs.git main'],
          run: async (ctx) => {
            const name = ctx.arg<string>('name').toLowerCase();
            const url = ctx.arg<string>('url');
            const branch = ctx.arg<string | undefined>('branch') ?? null;
            if (!REPO_NAME_RE.test(name)) throw new UserError(ctx.t('repo.add.badName'));
            if (!isAllowedGitUrl(url)) throw new UserError(ctx.t('repo.add.badUrl'));
            if (repos()[name]) throw new UserError(ctx.t('repo.add.exists', { name }));
            if (branch && !/^[\w./-]+$/.test(branch)) throw new UserError(ctx.t('repo.add.badBranch'));
            if (!(await ensureWarned(ctx))) return ctx.reply(ctx.t('common.cancelled'));
            await ctx.typing();
            // Die Nachricht mit Token möglichst entfernen
            if (/\/\/[^/@\s]+@/.test(url)) {
              await ctx.bot.platform.deleteMessage(ctx.channelId, ctx.message.id).catch(() => undefined);
            }
            await clone(name, url, branch);
            g().update<Record<string, RepoEntry>>('repos', (all) => ({ ...all, [name]: { url, branch, addedAt: new Date().toISOString() } }));
            const cogs = [...repoCogs(repoDir(name)).keys()];
            await ctx.send(ctx.t('repo.add.done', { name, url: maskUrl(url), count: cogs.length, cogs: cogs.map(inlineCode).join(', ') || '–' }));
          },
        },
        {
          name: 'delete',
          description: cog.t('repo.delete.description'),
          aliases: ['remove', 'del'],
          options: [{ name: 'name', description: cog.t('repo.add.name'), type: OptionType.String, required: true }],
          run: async (ctx) => {
            const name = ctx.arg<string>('name').toLowerCase();
            requireRepo(ctx, name);
            const fromRepo = Object.entries(installed()).filter(([, e]) => e.repo === name).map(([c]) => c);
            g().update<Record<string, RepoEntry>>('repos', (all) => {
              const { [name]: _removed, ...rest } = all;
              return rest;
            });
            fs.rmSync(repoDir(name), { recursive: true, force: true });
            await ctx.reply(ctx.t('repo.delete.done', { name, cogs: fromRepo.map(inlineCode).join(', ') || '–' }));
          },
        },
        {
          name: 'list',
          description: cog.t('repo.list.description'),
          run: async (ctx) => {
            const all = Object.entries(repos());
            if (!all.length) return ctx.reply(ctx.t('repo.list.empty', { prefix: ctx.prefix }));
            const lines = all.map(([n, e]) => `• **${n}** – <${maskUrl(e.url)}>${e.branch ? ` (${e.branch})` : ''}`);
            await ctx.sendEmbed({ title: ctx.t('repo.list.title'), description: lines.join('\n') });
          },
        },
        {
          name: 'info',
          description: cog.t('repo.info.description'),
          options: [{ name: 'name', description: cog.t('repo.add.name'), type: OptionType.String, required: true }],
          run: async (ctx) => {
            const name = ctx.arg<string>('name').toLowerCase();
            const entry = requireRepo(ctx, name);
            const dir = repoDir(name);
            const commit = await git(['log', '-1', '--format=%h %s (%cr)'], dir).catch(() => '–');
            const cogs = [...repoCogs(dir).values()];
            await ctx.sendEmbed({
              title: ctx.t('repo.info.title', { name }),
              fields: [
                { name: 'URL', value: maskUrl(entry.url) },
                { name: 'Branch', value: entry.branch ?? ctx.t('repo.info.defaultBranch'), inline: true },
                { name: 'Commit', value: commit, inline: true },
                {
                  name: ctx.t('repo.info.cogs', { count: cogs.length }),
                  value: cogs.map((c) => `\`${c.manifest.name}\` – ${c.manifest.description}`).join('\n').slice(0, 1024) || '–',
                },
              ],
            });
          },
        },
        {
          name: 'update',
          description: cog.t('repo.update.description'),
          options: [{ name: 'namen', description: cog.t('repo.update.names'), type: OptionType.String, variadic: true }],
          run: async (ctx) => {
            const names = (ctx.arg<string[] | undefined>('namen') ?? Object.keys(repos())).map((n) => n.toLowerCase());
            if (!names.length) return ctx.reply(ctx.t('repo.list.empty', { prefix: ctx.prefix }));
            await ctx.typing();
            const lines: string[] = [];
            for (const n of names) {
              if (!repos()[n]) {
                lines.push(`❌ ${ctx.t('repo.notFound', { name: n })}`);
                continue;
              }
              try {
                const { before, after } = await updateRepo(n);
                lines.push(before === after ? `➖ **${n}**: ${ctx.t('repo.update.unchanged')}` : `✅ **${n}**: ${before.slice(0, 7) || '∅'} → ${after.slice(0, 7)}`);
              } catch (err) {
                lines.push(`❌ **${n}**: ${(err as Error).message}`);
              }
            }
            await ctx.reply(`${lines.join('\n')}\n${ctx.t('repo.update.hint', { prefix: ctx.prefix })}`);
          },
        },
      ],
    });

    // ------------------------------------------------------------------ cog
    cog.group({
      name: 'cog',
      description: cog.t('cog.description'),
      permissions: { level: 'owner' },
      subcommands: [
        {
          name: 'install',
          description: cog.t('cog.install.description'),
          options: [
            { name: 'repo', description: cog.t('cog.repoOption'), type: OptionType.String, required: true },
            { name: 'cogs', description: cog.t('cog.cogsOption'), type: OptionType.String, required: true, variadic: true },
          ],
          examples: ['cog install meine afkchannel', 'cog install meine untis animewatch'],
          run: async (ctx) => {
            const repoName = ctx.arg<string>('repo').toLowerCase();
            requireRepo(ctx, repoName);
            if (!(await ensureWarned(ctx))) return ctx.reply(ctx.t('common.cancelled'));
            await ctx.typing();
            const lines: string[] = [];
            for (const raw of ctx.arg<string[]>('cogs')) {
              const name = raw.toLowerCase();
              try {
                const { npm, overridesBuiltin } = await installCog(repoName, name);
                lines.push(`✅ ${ctx.t('cog.install.done', { cog: name })}${npm.length ? ` (npm: ${npm.join(', ')})` : ''}`);
                if (overridesBuiltin) lines.push(`ℹ️ ${ctx.t('cog.install.overrides', { cog: name })}`);
                if (ctx.bot.cogs.isLoaded(name)) lines.push(`🔄 ${ctx.t('cog.install.reloadHint', { prefix: ctx.prefix, cog: name })}`);
              } catch (err) {
                lines.push(`❌ **${name}**: ${(err as Error).message}`);
              }
            }
            lines.push(ctx.t('cog.install.loadHint', { prefix: ctx.prefix }));
            await ctx.reply(lines.join('\n'));
          },
        },
        {
          name: 'uninstall',
          description: cog.t('cog.uninstall.description'),
          aliases: ['remove'],
          options: [{ name: 'cogs', description: cog.t('cog.cogsOption'), type: OptionType.String, required: true, variadic: true }],
          run: async (ctx) => {
            const lines: string[] = [];
            for (const raw of ctx.arg<string[]>('cogs')) {
              const name = raw.toLowerCase();
              if (!installed()[name]) {
                lines.push(`❌ ${ctx.t('cog.notInstalled', { cog: name })}`);
                continue;
              }
              if (name === cog.name) {
                lines.push(`❌ ${ctx.t('cog.uninstall.self')}`);
                continue;
              }
              try {
                if (ctx.bot.cogs.isLoaded(name)) {
                  await ctx.bot.cogs.unload(name);
                  ctx.bot.rememberCogs([name], false);
                }
                fs.rmSync(path.join(cogsDir, name), { recursive: true, force: true });
                g().update<Record<string, InstalledEntry>>('installed', (all) => {
                  const { [name]: _removed, ...rest } = all;
                  return rest;
                });
                lines.push(`🗑️ ${ctx.t('cog.uninstall.done', { cog: name })}`);
              } catch (err) {
                const e = err as { key?: string; vars?: Record<string, string>; message: string };
                lines.push(`❌ **${name}**: ${e.key ? ctx.t(e.key, e.vars) : e.message}`);
              }
            }
            await ctx.reply(lines.join('\n'));
          },
        },
        {
          name: 'update',
          description: cog.t('cog.update.description'),
          options: [{ name: 'cogs', description: cog.t('cog.cogsOption'), type: OptionType.String, variadic: true }],
          run: async (ctx) => {
            const all = installed();
            const names = (ctx.arg<string[] | undefined>('cogs') ?? Object.keys(all)).map((n) => n.toLowerCase());
            if (!names.length) return ctx.reply(ctx.t('cog.list.noneInstalled'));
            await ctx.typing();
            const lines: string[] = [];
            const updatedRepos = new Set<string>();
            for (const name of names) {
              const entry = all[name];
              if (!entry) {
                lines.push(`❌ ${ctx.t('cog.notInstalled', { cog: name })}`);
                continue;
              }
              try {
                if (!repos()[entry.repo]) throw new UserError(ctx.t('repo.notFound', { name: entry.repo }));
                if (!updatedRepos.has(entry.repo)) {
                  await updateRepo(entry.repo);
                  updatedRepos.add(entry.repo);
                }
                const source = repoCogs(repoDir(entry.repo)).get(name);
                if (!source) throw new UserError(ctx.t('cog.notInRepo', { cog: name, repo: entry.repo }));
                if (dirHash(source.dir) === entry.hash) {
                  lines.push(`➖ ${ctx.t('cog.update.unchanged', { cog: name })}`);
                  continue;
                }
                await installCog(entry.repo, name);
                if (ctx.bot.cogs.isLoaded(name)) {
                  await ctx.bot.cogs.reload(name);
                  lines.push(`✅ ${ctx.t('cog.update.reloaded', { cog: name, version: source.manifest.version })}`);
                } else {
                  lines.push(`✅ ${ctx.t('cog.update.done', { cog: name, version: source.manifest.version })}`);
                }
              } catch (err) {
                const e = err as { key?: string; vars?: Record<string, string>; message: string };
                lines.push(`❌ **${name}**: ${e.key ? ctx.t(e.key, e.vars) : e.message}`);
              }
            }
            await ctx.reply(lines.join('\n'));
          },
        },
        {
          name: 'list',
          description: cog.t('cog.list.description'),
          options: [{ name: 'repo', description: cog.t('cog.repoOption'), type: OptionType.String }],
          run: async (ctx) => {
            const repoName = ctx.arg<string | undefined>('repo')?.toLowerCase();
            const inst = installed();
            if (!repoName) {
              const entries = Object.entries(inst);
              if (!entries.length) return ctx.reply(ctx.t('cog.list.noneInstalled'));
              const lines = entries.map(
                ([n, e]) => `${ctx.bot.cogs.isLoaded(n) ? '🟢' : '⚪'} **${n}** – ${e.repo} @ ${e.commit.slice(0, 7)} (${formatDateTime(new Date(e.installedAt))})`,
              );
              return ctx.paginate(pagify(lines.join('\n'), { pageLength: 1800 }).map((p) => embed({ title: ctx.t('cog.list.installedTitle'), description: p })));
            }
            requireRepo(ctx, repoName);
            const cogs = [...repoCogs(repoDir(repoName)).values()];
            if (!cogs.length) return ctx.reply(ctx.t('cog.list.emptyRepo', { repo: repoName }));
            const lines = cogs.map(
              (c) => `${inst[c.manifest.name]?.repo === repoName ? '📦' : '▫️'} **${c.manifest.name}** ${c.manifest.version} – ${c.manifest.description}`,
            );
            await ctx.paginate(pagify(lines.join('\n'), { pageLength: 1800 }).map((p) => embed({ title: ctx.t('cog.list.repoTitle', { repo: repoName }), description: p })));
          },
        },
        {
          name: 'info',
          description: cog.t('cog.info.description'),
          options: [
            { name: 'repo', description: cog.t('cog.repoOption'), type: OptionType.String, required: true },
            { name: 'cog', description: cog.t('cog.cogsOption'), type: OptionType.String, required: true },
          ],
          run: async (ctx) => {
            const repoName = ctx.arg<string>('repo').toLowerCase();
            requireRepo(ctx, repoName);
            const found = repoCogs(repoDir(repoName)).get(ctx.arg<string>('cog').toLowerCase());
            if (!found) throw new UserError(ctx.t('cog.notInRepo', { cog: ctx.arg<string>('cog'), repo: repoName }));
            const m = found.manifest;
            await ctx.sendEmbed({
              title: `${m.name} ${m.version}`,
              description: m.description,
              fields: [
                { name: ctx.t('cog.info.author'), value: [m.author].flat().join(', '), inline: true },
                { name: ctx.t('cog.info.dependencies'), value: (m.dependencies ?? []).join(', ') || '–', inline: true },
                { name: 'npm', value: Object.entries(m.npmDependencies ?? {}).map(([n, v]) => `${n}@${v}`).join(', ') || '–', inline: true },
                { name: ctx.t('cog.info.endUserData'), value: m.endUserData ?? '–' },
              ],
            });
          },
        },
      ],
    });
  },
});
