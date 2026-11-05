import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VoiceService, type RtcConnection } from '../src/platform/voiceService.js';
import { silentLogger } from '../src/logger.js';
import { flush, IDS, makeBot, makeMessage, seedGuild, tempDir, type RestCall, type TestBot } from './helpers.js';
import { decide } from '../cogs/audio/index.js';
import { isSafeRevision } from '../cogs/downloader/index.js';

class FakeRtc extends EventEmitter implements RtcConnection {
  played: unknown[] = [];
  connected = false;
  volume = 100;
  private _playing = false;
  get playing() {
    return this._playing;
  }
  isConnected() {
    return this.connected;
  }
  async connect() {
    this.connected = true;
  }
  async play(src: string | NodeJS.ReadableStream) {
    this.played.push(src);
    this._playing = true;
    setTimeout(() => (this._playing = false), 5000); // "lange" Titel
  }
  setVolume(v: number) {
    this.volume = v;
  }
  getVolume() {
    return this.volume;
  }
  stop() {
    this._playing = false;
  }
  destroy() {
    this.connected = false;
  }
}

describe('Phase 5: reine Funktionen', () => {
  it('audio: Regeln für DJ, Abstimmung, Limits', () => {
    const s = { djRole: 'dj', voteSkip: true, maxQueue: 3, maxLength: 600, jukebox: 0 };
    const t = (duration: number | null) => ({ title: 'x', source: 'url' as const, ref: 'x', duration, requester: 'u' });
    const user = { privileged: false, control: false };
    const dj = { privileged: true, control: true };
    expect(decide(s, { action: 'enqueue', tracks: [t(100)], queueLength: 2 }, user)).toEqual({});
    expect(decide(s, { action: 'enqueue', tracks: [t(100), t(100)], queueLength: 2 }, user).block).toBe('guard.maxQueue');
    expect(decide(s, { action: 'enqueue', tracks: [t(900)], queueLength: 0 }, user).block).toBe('guard.maxLength');
    expect(decide(s, { action: 'enqueue', tracks: [t(900)], queueLength: 9 }, dj)).toEqual({});
    expect(decide({ ...s, jukebox: 5 }, { action: 'enqueue', tracks: [t(1)], queueLength: 0 }, { privileged: false, control: true })).toEqual({ charge: true });
    expect(decide({ ...s, jukebox: 5 }, { action: 'enqueue', tracks: [t(1)], queueLength: 0 }, dj)).toEqual({});
    expect(decide(s, { action: 'skip', queueLength: 0 }, user)).toEqual({ vote: true });
    expect(decide({ ...s, voteSkip: false }, { action: 'skip', queueLength: 0 }, user).block).toBe('guard.djOnly');
    expect(decide(s, { action: 'stop', queueLength: 0 }, user).block).toBe('guard.djOnly');
    expect(decide(s, { action: 'stop', queueLength: 0 }, dj)).toEqual({});
  });

  it('downloader: sichere Revisionen', () => {
    expect(isSafeRevision('v1.2.0')).toBe(true);
    expect(isSafeRevision('3f2a9c1')).toBe(true);
    expect(isSafeRevision('feature/neu')).toBe(true);
    expect(isSafeRevision('--upload-pack=evil')).toBe(false);
    expect(isSafeRevision('a/../b')).toBe(false);
    expect(isSafeRevision('')).toBe(false);
  });
});

let tb: TestBot;
let rtc: FakeRtc;
beforeEach(async () => {
  tb = await makeBot({ withBuiltinCogs: true, init: false });
  rtc = new FakeRtc();
  (tb.bot as unknown as { voice: VoiceService }).voice = new VoiceService(tb.platform, silentLogger(), async () => rtc, 2000);
  await tb.bot.init();
  seedGuild(tb.platform);
  tb.bot.core.guild(IDS.guild).set('modRoles', [IDS.roleMod]);
});
afterEach(async () => {
  tb.bot.scheduler.stopAll();
  await tb.bot.cogs.unloadAll();
});

async function say(content: string, author = IDS.user): Promise<void> {
  const before = tb.rest.calls.length;
  tb.platform.handleDispatch('MESSAGE_CREATE', makeMessage(content, author));
  await flush(40);
  // Langsame Befehle (Git, npm): auf eine Antwort warten
  for (let i = 0; i < 300 && /^!(cog|repo|findcog)/.test(content) && !tb.rest.calls.slice(before).some((c) => c.method === 'POST' && /\/messages$/.test(c.route)); i++) await flush(25);
}
const calls = (method: string, re: RegExp): RestCall[] => tb.rest.calls.filter((c) => c.method === method && re.test(c.route));
const texts = () => tb.rest.sentTexts();
const last = () => texts().at(-1) ?? '';
const inVoice = (user: string) =>
  tb.platform.handleDispatch('VOICE_STATE_UPDATE', { guild_id: IDS.guild, user_id: user, channel_id: IDS.voice, self_deaf: false, self_mute: false, mute: false, deaf: false });
const grant = () => tb.platform.handleDispatch('VOICE_SERVER_UPDATE', { guild_id: IDS.guild, channel_id: IDS.voice, endpoint: 'wss://lk', token: 't', connection_id: 'c' });

describe('audio', () => {
  beforeEach(async () => {
    for (const c of ['economy', 'jellyfinmusic', 'audio']) await tb.bot.cogs.load(c);
  });

  it('Playlists: anlegen, anhängen, abspielen, anzeigen, löschen', async () => {
    inVoice(IDS.user);
    await say('!playlist create chill');
    await say('!playlist append chill https://example.com/a.webm');
    await say('!playlist append chill https://example.com/b.webm');
    expect(last()).toContain('zu **chill** hinzugefügt');
    await say('!playlist show chill');
    expect(JSON.stringify(tb.rest.calls.at(-1)!.options!.body)).toContain('https://example.com/b.webm');
    await say('!playlist play chill');
    grant();
    for (let i = 0; i < 40 && !rtc.played.length; i++) await flush(25);
    expect(rtc.played[0]).toBe('https://example.com/a.webm');
    const music = tb.bot.cogApi<{ queue: (g: string) => unknown[] }>('jellyfinmusic')!;
    expect(music.queue(IDS.guild)).toHaveLength(1);
    await say('!playlist delete chill', IDS.mod); // fremde Playlist → nur als DJ/Mod
    expect(texts().some((t) => t.includes('wirklich löschen'))).toBe(true);
  });

  it('DJ-Rolle schützt Steuerung; Abstimmung zum Überspringen', async () => {
    await say(`!audioset dj <@&${IDS.roleAdmin}>`, IDS.admin);
    await say('!audioset voteskip an', IDS.admin);
    for (const u of [IDS.user, IDS.mod, IDS.owner]) inVoice(u);
    tb.platform.handleDispatch('MESSAGE_CREATE', makeMessage('!play https://example.com/a.webm', IDS.owner));
    await flush(40);
    grant();
    for (let i = 0; i < 40 && !rtc.played.length; i++) await flush(25);
    await say('!play https://example.com/b.webm', IDS.owner);
    await say('!stop', IDS.user);
    expect(last()).toMatch(/nur DJs/);
    await say('!volume 30', IDS.user);
    expect(last()).toMatch(/nur DJs/);
    await say('!skip', IDS.user);
    expect(last()).toMatch(/Stimme gezählt: 1\/2/);
    await say('!skip', IDS.mod); // Mods zählen als DJ → überspringt direkt
    for (let i = 0; i < 40 && rtc.played.length < 2; i++) await flush(25);
    expect(rtc.played[1]).toBe('https://example.com/b.webm');
  });

  it('Limits und Jukebox', async () => {
    inVoice(IDS.user);
    await say('!audioset maxqueue 1', IDS.admin);
    await say('!audioset jukebox 10', IDS.admin);
    await say('!play https://example.com/a.webm');
    expect(last()).toMatch(/Guthaben/);
    tb.bot.cogApi<{ deposit: (g: string, u: string, n: number) => number }>('economy')!.deposit(IDS.guild, IDS.user, 15);
    tb.platform.handleDispatch('MESSAGE_CREATE', makeMessage('!play https://example.com/a.webm', IDS.user));
    await flush(40);
    grant();
    for (let i = 0; i < 40 && !rtc.played.length; i++) await flush(25);
    expect(tb.bot.cogApi<{ balance: (g: string, u: string) => number }>('economy')!.balance(IDS.guild, IDS.user)).toBe(5);
    await say('!play https://example.com/b.webm');
    await say('!play https://example.com/c.webm');
    expect(last()).toMatch(/Warteschlange ist voll|Guthaben/);
  });

  it('repeat, shuffle, move, clearqueue, history', async () => {
    inVoice(IDS.user);
    tb.platform.handleDispatch('MESSAGE_CREATE', makeMessage('!play https://example.com/1.webm'));
    await flush(40);
    grant();
    for (let i = 0; i < 40 && !rtc.played.length; i++) await flush(25);
    for (const n of [2, 3, 4]) await say(`!play https://example.com/${n}.webm`);
    await say('!repeat liste');
    expect(last()).toMatch(/ganze Warteschlange/);
    await say('!move 3 1');
    const music = tb.bot.cogApi<{ queue: (g: string) => Array<{ ref: string }>; loop: (g: string) => string }>('jellyfinmusic')!;
    expect(music.queue(IDS.guild)[0]!.ref).toBe('https://example.com/4.webm');
    expect(music.loop(IDS.guild)).toBe('queue');
    await say('!shuffle');
    expect(last()).toMatch(/3 Titel gemischt/);
    await say('!clearqueue');
    expect(music.queue(IDS.guild)).toHaveLength(0);
    await say('!history');
    expect(last()).toMatch(/Noch nichts gespielt|Zuletzt/);
  });
});

describe('downloader (echtes Git-Repo)', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' }).toString().trim();
  const cogSource = (v: string) => `import { defineCog } from '@bot/sdk';\nexport default defineCog((cog) => { cog.command({ name: 'testcmd', description: 'x', run: (ctx) => ctx.send('version ${v}') }); });\n`;

  function makeRepo(): string {
    const dir = tempDir('cog-repo-');
    git(dir, 'init', '-q', '-b', 'main');
    fs.mkdirSync(path.join(dir, 'testcog'));
    const write = (v: string) => {
      fs.writeFileSync(path.join(dir, 'testcog', 'manifest.json'), JSON.stringify({ name: 'testcog', version: v, author: 't', description: 'Test' }));
      fs.writeFileSync(path.join(dir, 'testcog', 'index.ts'), cogSource(v));
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', `v${v}`);
    };
    write('1.0.0');
    git(dir, 'tag', 'v1');
    write('2.0.0');
    (makeRepo as unknown as { write: typeof write }).write = write;
    return dir;
  }

  it('installieren, auf Updates prüfen, aktualisieren, anheften, bestimmte Version', async () => {
    await tb.bot.cogs.load('downloader');
    const dl = tb.bot.cogs.loaded.get('downloader')!;
    const src = makeRepo();
    const write = (makeRepo as unknown as { write: (v: string) => void }).write;
    dl.config.global().setAll({ warned: true, repos: { lokal: { url: src, branch: null, addedAt: '' } } });
    // Klonen wie "repo add" (file://-URLs sind aus Sicherheitsgründen gesperrt, daher direkt)
    git(tb.dataDir, 'clone', '-q', src, path.join(tb.dataDir, 'repos', 'lokal'));

    await say('!cog install lokal testcog', IDS.botOwner);
    expect(last()).toContain('`testcog` installiert');
    await say('!load testcog', IDS.botOwner);
    await say('!testcmd');
    expect(last()).toBe('version 2.0.0');

    await say('!cog checkforupdates', IDS.botOwner);
    expect(last()).toMatch(/aktuell/);
    write('3.0.0');
    await say('!cog checkforupdates', IDS.botOwner);
    expect(last()).toMatch(/neue Version 3\.0\.0/);
    await say('!testcmd');
    expect(last()).toBe('version 2.0.0'); // nur geprüft, nicht installiert

    await say('!cog update', IDS.botOwner);
    expect(last()).toMatch(/3\.0\.0 aktualisiert und neu geladen/);
    await say('!testcmd');
    expect(last()).toBe('version 3.0.0');

    await say('!cog installversion lokal v1 testcog', IDS.botOwner);
    expect(last()).toMatch(/angeheftet/);
    await say('!testcmd');
    expect(last()).toBe('version 1.0.0');
    await say('!cog listpinned', IDS.botOwner);
    expect(last()).toContain('📌 **testcog** – v1');
    write('4.0.0');
    await say('!cog update', IDS.botOwner);
    expect(last()).toMatch(/angeheftet – übersprungen/);
    await say('!cog unpin testcog', IDS.botOwner);
    await say('!cog update', IDS.botOwner);
    await say('!testcmd');
    expect(last()).toBe('version 4.0.0');

    await say('!findcog testcmd', IDS.botOwner);
    expect(JSON.stringify(tb.rest.calls.at(-1)!.options!.body)).toContain('lokal @');
  });

  it('automatische Prüfung meldet neue Versionen einmal per DM an die Owner', async () => {
    await tb.bot.cogs.load('downloader');
    const dl = tb.bot.cogs.loaded.get('downloader')!;
    const src = makeRepo();
    const write = (makeRepo as unknown as { write: (v: string) => void }).write;
    dl.config.global().setAll({ warned: true, repos: { lokal: { url: src, branch: null, addedAt: '' } } });
    git(tb.dataDir, 'clone', '-q', src, path.join(tb.dataDir, 'repos', 'lokal'));
    await say('!cog install lokal testcog', IDS.botOwner);
    await say('!downloaderset autoupdate 1', IDS.botOwner);
    write('5.0.0');
    await tb.bot.scheduler.runNow('cog:downloader', 'auto-update');
    const dms = () => tb.rest.calls.filter((c) => c.route === '/channels/900/messages');
    expect(dms()).toHaveLength(1);
    expect(JSON.stringify(dms()[0]!.options!.body)).toContain('5.0.0');
    dl.config.global().set('lastAutoCheck', 0);
    await tb.bot.scheduler.runNow('cog:downloader', 'auto-update');
    expect(dms()).toHaveLength(1); // keine Wiederholung
  });
});
