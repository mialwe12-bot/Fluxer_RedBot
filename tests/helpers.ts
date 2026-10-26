import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bot } from '../src/bot.js';
import { APP_ROOT } from '../src/cogs/loader.js';
import { openDatabase } from '../src/db/database.js';
import type { Env } from '../src/env.js';
import { silentLogger } from '../src/logger.js';
import { FluxerPlatform } from '../src/platform/platform.js';
import type { APIMessage, RestLike, RestRequestOptions } from '../src/platform/types.js';

export interface RestCall {
  method: string;
  route: string;
  options?: RestRequestOptions;
}

/** REST-Fälschung: protokolliert Aufrufe und liefert plausible Antworten. */
export class FakeRest implements RestLike {
  readonly calls: RestCall[] = [];
  private nextId = 1000;
  /** Optional eigene Antworten/Fehler. */
  handler?: (call: RestCall) => unknown;

  private handle<T>(method: string, route: string, options?: RestRequestOptions): Promise<T> {
    const call = { method, route, options };
    this.calls.push(call);
    if (this.handler) {
      const r = this.handler(call);
      if (r instanceof Error) return Promise.reject(r);
      if (r !== undefined) return Promise.resolve(r as T);
    }
    const m = /^\/channels\/(\d+)\/messages(?:\/(\d+))?$/.exec(route);
    if (m && (method === 'POST' || method === 'PATCH')) {
      const body = (options?.body ?? {}) as Record<string, unknown>;
      return Promise.resolve({ id: m[2] ?? String(this.nextId++), channel_id: m[1], ...body } as T);
    }
    if (route === '/users/@me/channels') return Promise.resolve({ id: '900' } as T);
    return Promise.resolve(undefined as T);
  }

  get<T>(route: string, options?: RestRequestOptions): Promise<T> {
    return this.handle('GET', route, options);
  }
  post<T>(route: string, options?: RestRequestOptions): Promise<T> {
    return this.handle('POST', route, options);
  }
  patch<T>(route: string, options?: RestRequestOptions): Promise<T> {
    return this.handle('PATCH', route, options);
  }
  put<T>(route: string, options?: RestRequestOptions): Promise<T> {
    return this.handle('PUT', route, options);
  }
  delete<T>(route: string, options?: RestRequestOptions): Promise<T> {
    return this.handle('DELETE', route, options);
  }

  /** Inhalte aller gesendeten Nachrichten (Text + Embed-Titel/Beschreibungen). */
  sentTexts(): string[] {
    return this.calls
      .filter((c) => c.method === 'POST' && /\/messages$/.test(c.route))
      .map((c) => {
        const b = (c.options?.body ?? {}) as { content?: string; embeds?: Array<{ title?: string; description?: string }> };
        return [b.content ?? '', ...(b.embeds ?? []).map((e) => `${e.title ?? ''} ${e.description ?? ''}`)].join(' ').trim();
      });
  }
}

export const IDS = {
  guild: '100000000000000001',
  owner: '200000000000000001', // Serverbesitzer
  botOwner: '200000000000000099',
  admin: '200000000000000002',
  mod: '200000000000000003',
  user: '200000000000000004',
  bot: '300000000000000001',
  roleAdmin: '400000000000000001',
  roleMod: '400000000000000002',
  roleMember: '400000000000000003',
  channel: '500000000000000001',
  channel2: '500000000000000002',
  category: '500000000000000009',
  voice: '500000000000000010',
};

export function tempDir(prefix = 'fluxer-redbot-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function testEnv(dataDir: string): Env {
  return {
    baseUrl: 'https://chat.example.test',
    apiBaseUrl: 'https://chat.example.test/api',
    apiBaseUrlExplicit: true,
    apiVersion: '1',
    discovery: false,
    token: '123.abc',
    prefix: '!',
    ownerIds: [IDS.botOwner],
    locale: 'de',
    timezone: 'Europe/Berlin',
    dataDir,
    logLevel: 'silent',
    logPretty: false,
    watchdogSeconds: 600,
  };
}

export interface TestBot {
  bot: Bot;
  rest: FakeRest;
  platform: FluxerPlatform;
  dataDir: string;
  cogsDir: string;
}

/** Baut einen Bot ohne Gateway; Cogs werden nur aus `cogsDir` (temporär) geladen. */
export async function makeBot(options: { withBuiltinCogs?: boolean; init?: boolean } = {}): Promise<TestBot> {
  const dataDir = tempDir();
  const cogsDir = path.join(dataDir, 'cogs');
  fs.mkdirSync(cogsDir, { recursive: true });
  const rest = new FakeRest();
  const platform = new FluxerPlatform({ rest, logger: silentLogger() });
  platform.user = { id: IDS.bot, username: 'TestBot' } as never;
  const bot = new Bot({
    env: testEnv(dataDir),
    platform,
    db: openDatabase(':memory:'),
    logger: silentLogger(),
    cogPaths: [
      { dir: cogsDir, source: 'installed' },
      ...(options.withBuiltinCogs ? [{ dir: path.join(APP_ROOT, 'cogs'), source: 'builtin' as const }] : []),
    ],
    cacheDir: path.join(APP_ROOT, '.cogcache', `test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`),
    defaultCogs: [],
  });
  bot.exit = () => undefined;
  if (options.init !== false) await bot.init();
  return { bot, rest, platform, dataDir, cogsDir };
}

/** Schreibt einen Test-Cog in das Cog-Verzeichnis. */
export function writeCog(cogsDir: string, name: string, source: string, manifest: Record<string, unknown> = {}, extraFiles: Record<string, string> = {}): string {
  const dir = path.join(cogsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({ name, version: '1.0.0', author: 'test', description: `Test-Cog ${name}`, ...manifest }, null, 2),
  );
  fs.writeFileSync(path.join(dir, 'index.ts'), source);
  for (const [file, content] of Object.entries(extraFiles)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  return dir;
}

/** Legt eine Test-Guild im Plattform-Cache an. */
export function seedGuild(platform: FluxerPlatform): void {
  const everyonePerms = (1n << 10n) | (1n << 11n) | (1n << 6n) | (1n << 14n); // ViewChannel, SendMessages, AddReactions, EmbedLinks
  platform.handleDispatch('GUILD_CREATE', {
    id: IDS.guild,
    name: 'Testserver',
    owner_id: IDS.owner,
    roles: [
      { id: IDS.guild, name: '@everyone', position: 0, permissions: everyonePerms.toString(), color: 0, hoist: false, mentionable: false },
      { id: IDS.roleAdmin, name: 'Admins', position: 3, permissions: (1n << 3n).toString(), color: 0, hoist: false, mentionable: false },
      { id: IDS.roleMod, name: 'Mods', position: 2, permissions: ((1n << 13n) | (1n << 1n)).toString(), color: 0, hoist: false, mentionable: false },
      { id: IDS.roleMember, name: 'Mitglied', position: 1, permissions: '0', color: 0, hoist: false, mentionable: false },
    ],
    channels: [
      { id: IDS.category, type: 4, name: 'Text', permission_overwrites: [] },
      { id: IDS.channel, type: 0, name: 'allgemein', parent_id: IDS.category, permission_overwrites: [] },
      { id: IDS.channel2, type: 0, name: 'spam', parent_id: IDS.category, permission_overwrites: [] },
      { id: IDS.voice, type: 2, name: 'Sprachkanal', permission_overwrites: [] },
    ],
    members: [
      { user: { id: IDS.owner, username: 'besitzer' }, roles: [], joined_at: '', mute: false, deaf: false },
      { user: { id: IDS.admin, username: 'admina' }, roles: [IDS.roleAdmin], joined_at: '', mute: false, deaf: false },
      { user: { id: IDS.mod, username: 'moritz' }, roles: [IDS.roleMod, IDS.roleMember], joined_at: '', mute: false, deaf: false },
      { user: { id: IDS.user, username: 'nutzer' }, roles: [IDS.roleMember], joined_at: '', mute: false, deaf: false },
      { user: { id: IDS.botOwner, username: 'botowner' }, roles: [], joined_at: '', mute: false, deaf: false },
      { user: { id: IDS.bot, username: 'TestBot', bot: true }, roles: [IDS.roleAdmin], joined_at: '', mute: false, deaf: false },
    ],
    voice_states: [],
  });
}

let msgCounter = 1;
export function makeMessage(content: string, authorId: string = IDS.user, options: { guild?: boolean; channelId?: string } = {}): APIMessage {
  const guild = options.guild !== false;
  return {
    id: String(700000000000000000n + BigInt(msgCounter++)),
    channel_id: options.channelId ?? (guild ? IDS.channel : '600000000000000001'),
    guild_id: guild ? IDS.guild : undefined,
    author: { id: authorId, username: `u${authorId.slice(-2)}` },
    content,
    mentions: [],
    attachments: [],
    timestamp: new Date().toISOString(),
  } as unknown as APIMessage;
}

/** Wartet, bis alle Microtasks/kurzen Timer durch sind. */
export function flush(ms = 10): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
