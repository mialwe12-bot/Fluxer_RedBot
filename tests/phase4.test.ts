import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FluxerPlatform } from '../src/platform/platform.js';
import { VoiceService, type RtcConnection } from '../src/platform/voiceService.js';
import { silentLogger } from '../src/logger.js';
import { APP_ROOT } from '../src/cogs/loader.js';
import { flush, IDS, makeBot, makeMessage, seedGuild, FakeRest, type RestCall, type TestBot } from './helpers.js';
import { shouldMove } from '../cogs/afkchannel/index.js';
import { daysUntil, isBirthdayOn, parseBirthday } from '../cogs/birthday/index.js';
import { findBlacklisted } from '../cogs/gameblacklist/index.js';
import { dayKey, percentChange, EMOJI_RE } from '../cogs/dailystats/index.js';
import { decrypt, detectChanges, encrypt, parseKey, toSnap, type Snap } from '../cogs/untis/index.js';
import { parseProgress } from '../cogs/animewatch/index.js';
import { formatDuration, isYoutubeUrl, jellyfinStreamUrl } from '../cogs/jellyfinmusic/index.js';

const PHASE4 = ['afkchannel', 'untis', 'animewatch', 'dailystats', 'birthday', 'gameblacklist', 'jellyfinmusic'];
const AFK = '500000000000000011';
const KEY_HEX = 'a'.repeat(64);

/** Fake-LiveKit-Verbindung: play() "spielt" 80 ms. */
class FakeRtc extends EventEmitter implements RtcConnection {
  played: unknown[] = [];
  volume = 100;
  connected = false;
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
    setTimeout(() => (this._playing = false), 80);
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

// ---------------------------------------------------------------------- reine Funktionen
describe('Phase 4: reine Funktionen', () => {
  it('afkchannel: wann verschoben wird', () => {
    const s = { enabled: true, channel: AFK, delay: 60, moveBack: true, ignoredRoles: ['r1'], ignoredUsers: ['u2'], ignoredChannels: ['c9'] };
    const st = (o: Partial<{ channel_id: string | null; self_deaf: boolean; user_id: string }>) => ({ channel_id: 'c1', self_deaf: true, user_id: 'u1', ...o });
    expect(shouldMove(s, st({}), [], AFK)).toBe(true);
    expect(shouldMove(s, st({ self_deaf: false }), [], AFK)).toBe(false);
    expect(shouldMove(s, st({ channel_id: AFK }), [], AFK)).toBe(false);
    expect(shouldMove(s, st({ channel_id: null }), [], AFK)).toBe(false);
    expect(shouldMove(s, st({}), ['r1'], AFK)).toBe(false);
    expect(shouldMove(s, st({ user_id: 'u2' }), [], AFK)).toBe(false);
    expect(shouldMove(s, st({ channel_id: 'c9' }), [], AFK)).toBe(false);
    expect(shouldMove({ ...s, enabled: false }, st({}), [], AFK)).toBe(false);
  });

  it('birthday: Datum, 29. Februar, Tage bis', () => {
    expect(parseBirthday('24.12.')).toEqual({ day: 24, month: 12, year: null });
    expect(parseBirthday('29.02.2000')).toEqual({ day: 29, month: 2, year: 2000 });
    expect(parseBirthday('29.02.2001')).toBeUndefined();
    expect(parseBirthday('31.04.')).toBeUndefined();
    expect(parseBirthday('2000-01-05')).toEqual({ day: 5, month: 1, year: 2000 });
    const leapKid = { day: 29, month: 2, year: 2000 };
    expect(isBirthdayOn(leapKid, new Date(2027, 1, 28))).toBe(true);
    expect(isBirthdayOn(leapKid, new Date(2028, 1, 28))).toBe(false);
    expect(isBirthdayOn(leapKid, new Date(2028, 1, 29))).toBe(true);
    expect(daysUntil({ day: 5, month: 11, year: null }, new Date(2026, 10, 3))).toBe(2);
    expect(daysUntil({ day: 3, month: 11, year: null }, new Date(2026, 10, 3, 15))).toBe(0);
  });

  it('gameblacklist: Spielerkennung', () => {
    expect(findBlacklisted([{ name: 'Fortnite', type: 0 }], ['fortnite'])).toBe('Fortnite');
    expect(findBlacklisted([{ name: 'Call of Duty: Warzone', type: 0 }], ['call of duty*'])).toBe('Call of Duty: Warzone');
    expect(findBlacklisted([{ name: 'Fortnite', type: 2 }], ['fortnite'])).toBeNull();
    expect(findBlacklisted([{ name: 'Fortnite Festival', type: 0 }], ['fortnite'])).toBeNull();
    expect(findBlacklisted(undefined, ['x'])).toBeNull();
  });

  it('dailystats: Tage, Vergleich, Emojis', () => {
    expect(dayKey(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(percentChange(150, 100)).toBe('+50 %');
    expect(percentChange(50, 100)).toBe('−50 %');
    expect(percentChange(5, 0)).toBe('neu');
    expect('Hi 😀👍🏽 <:pepe:123> ❤️'.match(EMOJI_RE)).toEqual(['😀', '👍', '<:pepe:123>', '❤️']);
  });

  it('untis: Verschlüsselung (AES-256-GCM)', () => {
    const key = parseKey(KEY_HEX)!;
    expect(key).toHaveLength(32);
    expect(parseKey(Buffer.alloc(32, 7).toString('base64'))).toHaveLength(32);
    expect(parseKey('zu-kurz')).toBeNull();
    const blob = encrypt('geheim123', key);
    expect(blob).not.toContain('geheim');
    expect(encrypt('geheim123', key)).not.toBe(blob); // zufälliger IV
    expect(decrypt(blob, key)).toBe('geheim123');
    const parts = blob.split('.');
    parts[2] = Buffer.from('manipuliert').toString('base64');
    expect(() => decrypt(parts.join('.'), key)).toThrow();
    expect(() => decrypt(blob, parseKey('b'.repeat(64))!)).toThrow();
  });

  it('untis: Änderungserkennung', () => {
    const base = { kl: [], lsnumber: 1 };
    const lesson = (o: Record<string, unknown>) =>
      toSnap({ ...base, id: 1, date: 20261104, startTime: 800, endTime: 845, su: [{ id: 1, name: 'M', longname: 'Mathe' }], te: [{ id: 1, name: 'MÜL' }], ro: [{ id: 1, name: 'R101' }], ...o } as never);
    const normal = lesson({});
    expect(detectChanges(null, [normal])).toEqual([]);
    const cancelled = detectChanges(null, [lesson({ code: 'cancelled' })]);
    expect(cancelled.map((c) => c.type)).toEqual(['cancelled']);
    const sub = detectChanges(null, [lesson({ code: 'irregular', te: [{ id: 2, name: 'SCH', orgname: 'MÜL' }] })]);
    expect(sub.map((c) => c.type)).toEqual(['substitution', 'teacher']);
    expect(sub[1]!.detail).toEqual({ from: 'MÜL', to: 'SCH' });
    const room = detectChanges(null, [lesson({ ro: [{ id: 2, name: 'R205', orgname: 'R101' }] })]);
    expect(room.map((c) => c.type)).toEqual(['room']);
    const prev: Record<string, Snap> = { '1': normal };
    const moved = detectChanges(prev, [lesson({ startTime: 945, endTime: 1030 })]);
    expect(moved.map((c) => c.type)).toEqual(['time']);
    expect(moved[0]!.detail).toEqual({ from: '08:00–08:45', to: '09:45–10:30' });
    // gleiche Änderung → gleicher Schlüssel (keine Wiederholung)
    expect(detectChanges(prev, [lesson({ code: 'cancelled' })])[0]!.key).toBe(cancelled[0]!.key);
  });

  it('animewatch: Fortschritt', () => {
    expect(parseProgress(undefined, { episode: 3, season: 1 })).toEqual({ episode: 4, season: 1 });
    expect(parseProgress('+3', { episode: 3, season: 1 })).toEqual({ episode: 6, season: 1 });
    expect(parseProgress('12', { episode: 3, season: 2 })).toEqual({ episode: 12, season: 2 });
    expect(parseProgress('S2E5', { episode: 3, season: 1 })).toEqual({ episode: 5, season: 2 });
    expect(parseProgress('quatsch', { episode: 3, season: 1 })).toBeUndefined();
  });

  it('jellyfinmusic: Stream-URL und Helfer', () => {
    const url = new URL(jellyfinStreamUrl('https://jellyfin.example/', 'abc', 'KEY', 'U1'));
    expect(url.pathname).toBe('/Audio/abc/universal');
    expect(url.searchParams.get('AudioCodec')).toBe('opus');
    expect(url.searchParams.get('Container')).toBe('webm');
    expect(url.searchParams.get('api_key')).toBe('KEY');
    expect(isYoutubeUrl('https://youtu.be/x')).toBe(true);
    expect(isYoutubeUrl('https://example.com')).toBe(false);
    expect(formatDuration(3725)).toBe('1:02:05');
    expect(formatDuration(65)).toBe('1:05');
  });
});

// ---------------------------------------------------------------------- Voice-Handshake
describe('VoiceService', () => {
  function setup() {
    const sent: Array<{ op: number; d: Record<string, unknown> }> = [];
    const gateway = Object.assign(new EventEmitter(), {
      connect: async () => undefined,
      destroy: () => undefined,
      send: (_s: number, payload: { op: number; d: unknown }) => void sent.push(payload as never),
    });
    const platform = new FluxerPlatform({ rest: new FakeRest(), gateway, logger: silentLogger() });
    platform.user = { id: IDS.bot, username: 'Bot' } as never;
    const rtc = new FakeRtc();
    const voice = new VoiceService(platform, silentLogger(), async () => rtc, 500);
    return { sent, platform, rtc, voice };
  }

  it('op 4 → VOICE_SERVER_UPDATE → LiveKit verbunden; verlassen sendet channel_id null', async () => {
    const { sent, platform, rtc, voice } = setup();
    const joining = voice.join(IDS.guild, IDS.voice);
    expect(sent[0]).toMatchObject({ op: 4, d: { guild_id: IDS.guild, channel_id: IDS.voice } });
    expect(typeof sent[0]!.d.mutation_id).toBe('string');
    platform.handleDispatch('VOICE_SERVER_UPDATE', { guild_id: IDS.guild, channel_id: IDS.voice, endpoint: 'wss://lk.example', token: 'tok', connection_id: 'c1' });
    const session = await joining;
    expect(session.conn).toBe(rtc);
    expect(rtc.connected).toBe(true);
    await voice.playAndWait(IDS.guild, 'https://example.com/a.webm');
    expect(rtc.played).toEqual(['https://example.com/a.webm']);
    voice.leave(IDS.guild);
    expect(sent.at(-1)).toMatchObject({ op: 4, d: { guild_id: IDS.guild, channel_id: null, connection_id: 'c1' } });
    expect(voice.get(IDS.guild)).toBeUndefined();
  });

  it('Ablehnung per VOICE_STATE_ACK und Timeout werden verständlich gemeldet', async () => {
    const { sent, platform, voice } = setup();
    const joining = voice.join(IDS.guild, IDS.voice);
    platform.handleDispatch('VOICE_STATE_ACK', { mutation_id: sent[0]!.d.mutation_id, status: 'rejected', error_code: 'MISSING_PERMISSIONS' });
    await expect(joining).rejects.toThrow(/MISSING_PERMISSIONS/);
    await expect(voice.join(IDS.guild, IDS.voice)).rejects.toThrow(/Keine Antwort/);
  });
});

// ---------------------------------------------------------------------- Ende-zu-Ende
let tb: TestBot;
let rtc: FakeRtc;
const realFetch = globalThis.fetch;
beforeEach(async () => {
  process.env.UNTIS_ENCRYPTION_KEY = KEY_HEX;
  tb = await makeBot({ withBuiltinCogs: true, init: false });
  rtc = new FakeRtc();
  // Voice mit Fake-LiveKit (bevor Cogs geladen werden)
  (tb.bot as unknown as { voice: VoiceService }).voice = new VoiceService(tb.platform, silentLogger(), async () => rtc, 2000);
  await tb.bot.init();
  seedGuild(tb.platform);
  tb.platform.handleDispatch('CHANNEL_CREATE', { id: AFK, type: 2, name: 'AFK', guild_id: IDS.guild, permission_overwrites: [] });
  tb.bot.core.guild(IDS.guild).set('modRoles', [IDS.roleMod]);
  for (const c of PHASE4) if (!tb.bot.cogs.isLoaded(c)) await tb.bot.cogs.load(c);
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  tb.bot.scheduler.stopAll();
  await tb.bot.cogs.unloadAll();
});

async function say(content: string, author = IDS.user, opts: { guild?: boolean } = {}): Promise<void> {
  tb.platform.handleDispatch('MESSAGE_CREATE', makeMessage(content, author, opts));
  await flush(40);
}
const calls = (method: string, re: RegExp): RestCall[] => tb.rest.calls.filter((c) => c.method === method && re.test(c.route));
const texts = () => tb.rest.sentTexts();
const last = () => texts().at(-1) ?? '';
const voiceState = (user: string, channel: string | null, extra: Record<string, unknown> = {}) =>
  tb.platform.handleDispatch('VOICE_STATE_UPDATE', { guild_id: IDS.guild, user_id: user, channel_id: channel, self_deaf: false, self_mute: false, mute: false, deaf: false, ...extra });

describe('Alle Cogs zusammen', () => {
  it('sämtliche mitgelieferten Cogs (Phase 1–4) laden ohne Konflikte', async () => {
    const all = fs.readdirSync(path.join(APP_ROOT, 'cogs')).filter((d) => fs.existsSync(path.join(APP_ROOT, 'cogs', d, 'manifest.json')));
    for (const c of all) if (!tb.bot.cogs.isLoaded(c)) await tb.bot.cogs.load(c);
    expect(all.length).toBeGreaterThanOrEqual(39);
    for (const c of all) expect(tb.bot.cogs.isLoaded(c), c).toBe(true);
  });
});

describe('afkchannel', () => {
  it('verschiebt taub Geschaltete und auf Wunsch zurück', async () => {
    await say(`!afkchannel set <#${AFK}>`, IDS.admin);
    await say('!afkchannel delay 0', IDS.admin);
    await say('!afkchannel moveback an', IDS.admin);
    voiceState(IDS.user, IDS.voice);
    voiceState(IDS.user, IDS.voice, { self_deaf: true });
    await flush(40);
    const move = calls('PATCH', new RegExp(`/members/${IDS.user}$`)).at(-1)!;
    expect(move.options!.body).toEqual({ channel_id: AFK });
    voiceState(IDS.user, AFK, { self_deaf: true });
    voiceState(IDS.user, AFK, { self_deaf: false });
    await flush(40);
    expect(calls('PATCH', new RegExp(`/members/${IDS.user}$`)).at(-1)!.options!.body).toEqual({ channel_id: IDS.voice });
  });

  it('wartet die Verzögerung ab und bricht beim Ent-Taubschalten ab', async () => {
    await say(`!afkchannel set <#${AFK}>`, IDS.admin);
    await say('!afkchannel delay 1', IDS.admin);
    voiceState(IDS.mod, IDS.voice, { self_deaf: true });
    voiceState(IDS.mod, IDS.voice, { self_deaf: false });
    await flush(1200);
    expect(calls('PATCH', new RegExp(`/members/${IDS.mod}$`))).toHaveLength(0);
  });
});

describe('birthday', () => {
  it('Glückwunsch zur Uhrzeit mit Rolle', async () => {
    const now = new Date();
    await say(`!birthday set ${now.getDate()}.${now.getMonth() + 1}.2000`, IDS.user);
    expect(last()).toContain('Gespeichert');
    await say(`!bdset channel <#${IDS.channel2}>`, IDS.admin);
    await say(`!bdset role <@&${IDS.roleMember}>`, IDS.admin);
    await say('!bdset time 00:00', IDS.admin);
    tb.bot.cogs.loaded.get('birthday')!.config.guild(IDS.guild).set('lastRun', '');
    await tb.bot.scheduler.runNow('cog:birthday', 'geburtstage');
    const post = calls('POST', new RegExp(`/channels/${IDS.channel2}/messages$`)).at(-1)!;
    expect((post.options!.body as { content: string }).content).toContain(`<@${IDS.user}>`);
    expect((post.options!.body as { content: string }).content).toContain(`${now.getFullYear() - 2000}`);
    expect(calls('PUT', new RegExp(`/members/${IDS.user}/roles/${IDS.roleMember}$`))).toHaveLength(1);
    await say('!birthday list', IDS.user);
    expect(JSON.stringify(tb.rest.calls.at(-1)!.options!.body)).toContain('🎂');
  });
});

describe('gameblacklist', () => {
  it('Timeout bei verbotenem Spiel; Diagnose zählt Aktivitäten', async () => {
    await say('!gameblacklist add Fortnite', IDS.admin);
    await say('!gameblacklist toggle an', IDS.admin);
    expect(last()).toMatch(/keine einzige Spiel-Aktivität/);
    tb.platform.handleDispatch('PRESENCE_UPDATE', { user: { id: IDS.user }, guild_id: IDS.guild, status: 'online', activities: [{ name: 'Fortnite', type: 0 }] });
    await flush(40);
    expect(calls('PATCH', new RegExp(`/members/${IDS.user}$`))[0]!.options!.body).toHaveProperty('communication_disabled_until');
    tb.platform.handleDispatch('PRESENCE_UPDATE', { user: { id: IDS.mod }, guild_id: IDS.guild, activities: [{ name: 'Fortnite', type: 0 }] });
    await flush(40);
    expect(calls('PATCH', new RegExp(`/members/${IDS.mod}$`))).toHaveLength(0); // Mods sind ausgenommen
    await say('!gameblacklist status', IDS.admin);
    expect(last()).toMatch(/2 Presence-Updates, davon 2 mit Spiel-Aktivität/);
  });
});

describe('dailystats', () => {
  it('zählt Nachrichten (ohne Inhalt), wrapped, opt-out und Tagespost', async () => {
    for (const t of ['Hallo 😀', 'Wie gehts? 😀', 'gut']) await say(t, IDS.user);
    await say('Moin', IDS.mod);
    await say('!wrapped', IDS.user);
    const body = JSON.stringify(tb.rest.calls.at(-1)!.options!.body);
    expect(body).toContain('**3 Nachrichten**');
    expect(body).toContain('😀 ×2');
    // Keine Inhalte in der Datenbank
    const rows = tb.bot.db.prepare(`SELECT key FROM cog_dailystats_counts`).all() as Array<{ key: string }>;
    expect(rows.some((r) => r.key.includes('Hallo'))).toBe(false);
    await say('!stats optout', IDS.mod);
    await say('noch eine', IDS.mod);
    await say('!stats delete', IDS.mod);
    // Bestätigung per ✅ simulieren ist aufwendig – Opt-out reicht: weitere Nachrichten zählen nicht
    const modCount = tb.bot.db.prepare(`SELECT SUM(value) v FROM cog_dailystats_counts WHERE kind='msg_user' AND key=?`).get(IDS.mod) as { v: number };
    expect(modCount.v).toBe(1);
    const ds = tb.bot.cogs.loaded.get('dailystats')!;
    ds.config.guild(IDS.guild).setAll({ channel: IDS.channel2, dailyTime: '00:00', lastDaily: '' });
    await tb.bot.scheduler.runNow('cog:dailystats', 'posts');
    const post = calls('POST', new RegExp(`/channels/${IDS.channel2}/messages$`)).at(-1)!;
    expect(JSON.stringify(post.options!.body)).toContain('Tagesrückblick');
  });

  it('Wochen-Wrapped mit Awards', async () => {
    for (let i = 0; i < 4; i++) await say(`Nachricht ${i}`, IDS.user);
    await say('!stats week', IDS.user);
    const body = JSON.stringify(tb.rest.calls.at(-1)!.options!.body);
    expect(body).toContain('Wrapped');
    expect(body).toContain('Dauerredner');
  });
});

describe('untis', () => {
  it('Zugangsdaten im Server werden gelöscht und gewarnt; ohne Anmeldung klare Meldung', async () => {
    const msg = makeMessage('!untis login neilo.webuntis.com schule max geheim', IDS.user);
    tb.platform.handleDispatch('MESSAGE_CREATE', msg);
    await flush(60);
    expect(calls('DELETE', new RegExp(`/messages/${msg.id}$`))).toHaveLength(1);
    expect(texts().some((t) => t.includes('niemals'))).toBe(true);
    const slash = makeMessage('/untis login a b c d', IDS.user);
    tb.platform.handleDispatch('MESSAGE_CREATE', slash);
    await flush(40);
    expect(calls('DELETE', new RegExp(`/messages/${slash.id}$`))).toHaveLength(1);
    await say('!untis heute', IDS.user);
    expect(last()).toMatch(/nicht angemeldet/);
  });
});

describe('animewatch (AniList gefälscht)', () => {
  it('suchen, hinzufügen, Fortschritt, Benachrichtigung bei neuer Folge', async () => {
    let airingAt = Math.floor(Date.now() / 1000) + 3600;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes('anilist')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { query: string };
        const media = { id: 154587, title: { romaji: 'Sousou no Frieren', english: 'Frieren' }, episodes: 28, seasonYear: 2023, coverImage: { medium: '' }, nextAiringEpisode: { episode: 5, airingAt } };
        return new Response(JSON.stringify({ data: { Page: { media: body.query.includes('id_in') ? [media] : [media] } } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return realFetch(url, init);
    }) as typeof fetch;
    await say('!watch add Frieren', IDS.user);
    expect(last()).toContain('Frieren');
    await say('!watch progress 1', IDS.user);
    expect(last()).toContain('1/28');
    await say('!watch list', IDS.user);
    expect(JSON.stringify(tb.rest.calls.at(-1)!.options!.body)).toContain('am Schauen');
    await tb.bot.scheduler.runNow('cog:animewatch', 'release-check'); // initialisiert
    airingAt = Math.floor(Date.now() / 1000) + 7200;
    tb.bot.cogs.loaded.get('animewatch')!.config.custom('media', 'anilist:anime:154587').set('airingAt', Math.floor(Date.now() / 1000) - 10);
    await tb.bot.scheduler.runNow('cog:animewatch', 'release-check');
    expect(texts().some((t) => t.includes('Folge 5 ist erschienen'))).toBe(true);
    await say('!watch upcoming', IDS.user);
    expect(JSON.stringify(tb.rest.calls.at(-1)!.options!.body)).toContain('Folge 5');
  });
});

describe('jellyfinmusic (Fake-LiveKit)', () => {
  it('play tritt dem Sprachkanal bei, spielt ab, stop verlässt', async () => {
    voiceState(IDS.user, IDS.voice);
    tb.platform.handleDispatch('MESSAGE_CREATE', makeMessage('!play https://example.com/song.webm', IDS.user));
    await flush(60);
    tb.platform.handleDispatch('VOICE_SERVER_UPDATE', { guild_id: IDS.guild, channel_id: IDS.voice, endpoint: 'wss://lk.example', token: 'tok', connection_id: 'c9' });
    for (let i = 0; i < 40 && !texts().some((t) => t.includes('Jetzt läuft')); i++) await flush(25);
    expect(rtc.played).toEqual(['https://example.com/song.webm']);
    expect(texts().some((t) => t.includes('Jetzt läuft'))).toBe(true);
    await say('!volume 50', IDS.user);
    expect(rtc.volume).toBe(50);
    await say('!stop', IDS.user);
    expect(tb.bot.voice.get(IDS.guild)).toBeUndefined();
  });

  it('ohne Sprachkanal verständliche Meldung', async () => {
    await say('!play irgendwas', IDS.mod);
    expect(last()).toMatch(/Sprachkanal/);
  });
});
