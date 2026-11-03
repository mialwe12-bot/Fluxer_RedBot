import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flush, IDS, makeBot, makeMessage, seedGuild, tempDir, type RestCall, type TestBot } from './helpers.js';
import { levelFromXp, totalXpForLevel, xpForNext, progressBar } from '../cogs/levelup/index.js';
import { slotPayout } from '../cogs/economy/index.js';
import { rpsWinner, upsideDown } from '../cogs/general/index.js';
import { renderTemplate } from '../cogs/customcom/index.js';
import { renderWelcome } from '../cogs/welcome/index.js';
import { isCorrect, normalize, validateList } from '../cogs/trivia/index.js';
import { completedLines, makeCard, resolveCell, CENTER } from '../cogs/bingo/index.js';
import { convertUnit } from '../cogs/conversions/index.js';
import { parseWhen } from '../cogs/eventposter/index.js';
import { parseYoutubeFeed, youtubeChannelIdFrom } from '../cogs/streams/index.js';
import { imgurImage } from '../cogs/image/index.js';
import { extractInstagramUrls } from '../cogs/instadl/index.js';
import { transcript } from '../cogs/tickets/index.js';

const PHASE3 = [
  'economy',
  'levelup',
  'general',
  'customcom',
  'welcome',
  'suggestions',
  'tickets',
  'badges',
  'trivia',
  'bingo',
  'conversions',
  'eventposter',
  'streams',
  'image',
  'instadl',
];
const CH2 = IDS.channel2;

// ---------------------------------------------------------------------- reine Funktionen
describe('Phase 3: reine Funktionen', () => {
  it('Level-Formel', () => {
    expect(xpForNext(0)).toBe(100);
    expect(totalXpForLevel(2)).toBe(100 + 155);
    expect(levelFromXp(0)).toEqual({ level: 0, current: 0, needed: 100 });
    expect(levelFromXp(255)).toMatchObject({ level: 2, current: 0 });
    expect(levelFromXp(totalXpForLevel(10) + 5).level).toBe(10);
    expect(progressBar(5, 10, 10)).toBe('▰▰▰▰▰▱▱▱▱▱');
  });

  it('Spielautomat und Schere-Stein-Papier', () => {
    expect(slotPayout(['7️⃣', '7️⃣', '7️⃣']).multiplier).toBe(50);
    expect(slotPayout(['🍒', '🍋', '🍒']).multiplier).toBe(3);
    expect(slotPayout(['🍋', '🍋', '🍊']).multiplier).toBe(2);
    expect(slotPayout(['🍋', '🍊', '🍇']).multiplier).toBe(0);
    expect(rpsWinner('stein', 'schere')).toBe(1);
    expect(rpsWinner('stein', 'papier')).toBe(2);
    expect(rpsWinner('papier', 'papier')).toBe(0);
    expect(upsideDown('abc')).toBe('ɔqɐ');
  });

  it('Platzhalter in eigenen Befehlen und Begrüßungen', () => {
    const c = { author: { id: '1', username: 'anna' }, channelId: '2', channelName: 'allgemein', serverName: 'Test', args: ['a', 'b'], uses: 3 };
    expect(renderTemplate('Hi {author}, {0}+{1} in {channel.name} auf {server} ({uses})', c)).toBe('Hi <@1>, a+b in allgemein auf Test (3)');
    expect(renderWelcome('{member} / {member.name} / {server} / {count}', { id: '9', name: 'bob', server: 'S', count: 1234 })).toBe('<@9> / bob / S / 1.234');
  });

  it('Trivia: Antwortprüfung und Listenformat', () => {
    expect(normalize('Grün!')).toBe('gruen');
    expect(isCorrect('gruen', ['Grün'])).toBe(true);
    expect(isCorrect('Ich glaube Goethe', ['Goethe'])).toBe(true);
    expect(isCorrect('16', ['16', 'sechzehn'])).toBe(true);
    expect(isCorrect('116', ['16'])).toBe(false);
    expect(isCorrect('Rom', ['Romania'])).toBe(false);
    expect(() => validateList({ questions: [] })).toThrow();
    for (const f of fs.readdirSync('cogs/trivia/lists')) {
      expect(validateList(JSON.parse(fs.readFileSync(path.join('cogs/trivia/lists', f), 'utf8'))).questions.length).toBeGreaterThanOrEqual(20);
    }
  });

  it('Bingo: Karte, Felder, Reihen', () => {
    const tiles = Array.from({ length: 30 }, (_, i) => `Feld ${i + 1}`);
    const card = makeCard(tiles, 'FREI');
    expect(card).toHaveLength(25);
    expect(card[CENTER]).toBe('FREI');
    expect(new Set(card).size).toBe(25);
    expect(resolveCell('B1', card)).toBe(0);
    expect(resolveCell('o5', card)).toBe(24);
    expect(resolveCell('13', card)).toBe(12);
    expect(resolveCell(card[3]!, card)).toBe(3);
    expect(completedLines(new Set([0, 1, 2, 3]))).toHaveLength(0);
    expect(completedLines(new Set([0, 6, 12, 18, 24]))).toEqual([[0, 6, 12, 18, 24]]);
  });

  it('Einheiten umrechnen', () => {
    expect(convertUnit(1, 'km', 'm')).toBe(1000);
    expect(convertUnit(1, 'mi', 'km')).toBeCloseTo(1.609344);
    expect(convertUnit(100, '°c', '°f')).toBeCloseTo(212);
    expect(convertUnit(0, 'k', 'c')).toBeCloseTo(-273.15);
    expect(convertUnit(1, 'gib', 'mb')).toBeCloseTo(1073.741824);
    expect(convertUnit(1, 'km', 'kg')).toBeUndefined();
  });

  it('Zeitangaben für Events', () => {
    const now = new Date(2026, 10, 3, 12, 0); // Dienstag, 3.11.2026 12:00
    expect(parseWhen('morgen 20:00', now)).toEqual(new Date(2026, 10, 4, 20, 0));
    expect(parseWhen('heute 18 Uhr', now)).toEqual(new Date(2026, 10, 3, 18, 0));
    expect(parseWhen('Samstag 19:30', now)).toEqual(new Date(2026, 10, 7, 19, 30));
    expect(parseWhen('Dienstag 10:00', now)).toEqual(new Date(2026, 10, 10, 10, 0));
    expect(parseWhen('24.12. 18:00', now)).toEqual(new Date(2026, 11, 24, 18, 0));
    expect(parseWhen('1.1. 0:00', now)).toEqual(new Date(2027, 0, 1, 0, 0));
    expect(parseWhen('in 2h', now)!.getTime() - now.getTime()).toBe(2 * 3600_000);
    expect(parseWhen('11:00', now)).toEqual(new Date(2026, 10, 4, 11, 0));
    expect(parseWhen('31.02.2026 10:00', now)).toBeUndefined();
    expect(parseWhen('irgendwann', now)).toBeUndefined();
  });

  it('YouTube-Feed, Imgur, Instagram-Links, Ticket-Protokoll', () => {
    const xml = `<feed><author><name>Kanal &amp; Co</name></author><entry><yt:videoId>abc123</yt:videoId><title>Neues Video</title><link rel="alternate" href="https://www.youtube.com/watch?v=abc123"/><published>2026-11-01T10:00:00+00:00</published></entry></feed>`;
    expect(parseYoutubeFeed(xml)).toEqual([{ videoId: 'abc123', title: 'Neues Video', url: 'https://www.youtube.com/watch?v=abc123', published: '2026-11-01T10:00:00+00:00', author: 'Kanal & Co' }]);
    expect(youtubeChannelIdFrom('https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw')).toBe('UC_x5XG1OV2P6uZZ5FSM9Ttw');
    expect(imgurImage({ title: 'x', link: 'https://i.imgur.com/a.png' })).toBe('https://i.imgur.com/a.png');
    expect(imgurImage({ title: 'x', link: 'https://imgur.com/a/1', is_album: true, images: [{ link: 'https://i.imgur.com/b.mp4', type: 'video/mp4' }, { link: 'https://i.imgur.com/c.jpg', type: 'image/jpeg' }] })).toBe('https://i.imgur.com/c.jpg');
    expect(extractInstagramUrls('schau mal https://www.instagram.com/reel/AbC_12-x/?igsh=1 und https://instagram.com/p/XyZ/')).toEqual([
      'https://www.instagram.com/reel/AbC_12-x/?igsh=1',
      'https://instagram.com/p/XyZ/',
    ]);
    const t = transcript([{ author: { id: '1', username: 'b' }, content: 'zwei', timestamp: '2026-11-01T10:01:00Z', attachments: [], embeds: [] }, { author: { id: '1', username: 'a' }, content: 'eins', timestamp: '2026-11-01T10:00:00Z', attachments: [], embeds: [] }] as never, 'Kopf');
    expect(t.split('\n').slice(2).map((l) => l.replace(/^\[[^\]]*\] /, ''))).toEqual(['a: eins', 'b: zwei']);
  });
});

// ---------------------------------------------------------------------- Ende-zu-Ende
let tb: TestBot;
const channelCounter = { n: 0 };
beforeEach(async () => {
  tb = await makeBot({ withBuiltinCogs: true });
  seedGuild(tb.platform);
  tb.bot.core.guild(IDS.guild).set('modRoles', [IDS.roleMod]);
  tb.rest.handler = (c) => {
    if (c.method === 'POST' && c.route === `/guilds/${IDS.guild}/channels`) {
      return { id: String(510000000000000000n + BigInt(++channelCounter.n)), guild_id: IDS.guild, ...(c.options!.body as object) };
    }
    return undefined;
  };
  for (const c of PHASE3) if (!tb.bot.cogs.isLoaded(c)) await tb.bot.cogs.load(c);
});
afterEach(async () => {
  tb.bot.scheduler.stopAll();
  await tb.bot.cogs.unloadAll();
});

async function say(content: string, author = IDS.user, channelId?: string): Promise<void> {
  tb.platform.handleDispatch('MESSAGE_CREATE', makeMessage(content, author, channelId ? { channelId } : {}));
  await flush(40);
}
const calls = (method: string, re: RegExp): RestCall[] => tb.rest.calls.filter((c) => c.method === method && re.test(c.route));
const texts = () => tb.rest.sentTexts();
const last = () => texts().at(-1) ?? '';
const waitFor = async (pred: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await flush(20);
};

describe('Phase 3: alle Cogs', () => {
  it('laden ohne Befehlskonflikte (zusammen mit Phase 1)', () => {
    for (const c of PHASE3) expect(tb.bot.cogs.isLoaded(c)).toBe(true);
    const seen = new Set<string>();
    for (const cmd of tb.bot.registry.all()) {
      for (const n of [cmd.name, ...(cmd.aliases ?? [])]) {
        expect(seen.has(n), `doppelt: ${n}`).toBe(false);
        seen.add(n);
      }
    }
  });
});

describe('economy', () => {
  it('payday, transfer, Bestenliste und Cooldown', async () => {
    await say('!payday', IDS.user);
    expect(last()).toContain('120 Taler');
    await say('!payday', IDS.user);
    expect(last()).toMatch(/nächster Zahltag/);
    await say(`!transfer <@${IDS.mod}> 50`, IDS.user);
    const eco = tb.bot.cogApi<{ balance: (g: string, u: string) => number }>('economy')!;
    expect(eco.balance(IDS.guild, IDS.user)).toBe(70);
    expect(eco.balance(IDS.guild, IDS.mod)).toBe(50);
    await say(`!transfer <@${IDS.mod}> 500`, IDS.user);
    expect(last()).toMatch(/Nicht genug Guthaben/);
    await say('!leaderboard', IDS.user);
    expect(last()).toMatch(/🥇 <@200000000000000004> – 70 Taler/);
    await say(`!bank set <@${IDS.user}> +30`, IDS.admin);
    expect(eco.balance(IDS.guild, IDS.user)).toBe(100);
  });
});

describe('customcom + alias', () => {
  it('eigener Befehl mit Argumenten; Alias hat Vorrang', async () => {
    await tb.bot.cogs.load('alias');
    await say('!customcom create simple hallo Hallo {author}, du sagst {0}!', IDS.mod);
    await say('!hallo Moin', IDS.user);
    expect(last()).toBe(`Hallo <@${IDS.user}>, du sagst Moin!`);
    await say('!customcom create random los A | B | C', IDS.mod);
    await say('!los', IDS.user);
    expect(['A', 'B', 'C']).toContain(last());
    await say('!alias add hallo uptime', IDS.mod);
    await say('!hallo', IDS.user);
    expect(last()).toMatch(/Online seit/);
  });
});

describe('welcome, suggestions, tickets', () => {
  it('Begrüßung beim Beitritt', async () => {
    await say(`!welcomeset channel <#${CH2}>`, IDS.admin);
    await say('!welcomeset toggle an', IDS.admin);
    tb.platform.handleDispatch('GUILD_MEMBER_ADD', { guild_id: IDS.guild, user: { id: '200000000000000077', username: 'neu' }, roles: [] });
    await flush(40);
    const post = calls('POST', new RegExp(`/channels/${CH2}/messages$`)).at(-1)!;
    expect((post.options!.body as { content: string }).content).toContain('<@200000000000000077>');
  });

  it('Vorschlag einreichen und annehmen', async () => {
    await say(`!suggestset channel <#${CH2}>`, IDS.admin);
    await say('!suggest Mehr Emojis bitte', IDS.user);
    expect(calls('POST', new RegExp(`/channels/${CH2}/messages$`))).toHaveLength(1);
    expect(calls('PUT', /reactions/).length).toBeGreaterThanOrEqual(2);
    await say('!suggestion approve 1 Gute Idee', IDS.mod);
    const edit = calls('PATCH', new RegExp(`/channels/${CH2}/messages/`)).at(-1)!;
    expect(JSON.stringify(edit.options!.body)).toContain('Gute Idee');
  });

  it('Ticket öffnen, Mitglied hinzufügen, schließen mit Protokoll', async () => {
    await say(`!ticketset log <#${CH2}>`, IDS.admin);
    await say('!ticket new Ich brauche Hilfe', IDS.user);
    const create = calls('POST', new RegExp(`/guilds/${IDS.guild}/channels$`))[0]!;
    const body = create.options!.body as { name: string; permission_overwrites: Array<{ id: string; deny: string }> };
    expect(body.name).toBe('ticket-0001');
    expect(body.permission_overwrites.find((o) => o.id === IDS.guild)!.deny).not.toBe('0');
    const ticketChannel = String(510000000000000000n + BigInt(channelCounter.n));
    await say(`!ticket add <@${IDS.mod}>`, IDS.user, ticketChannel);
    expect(calls('PUT', new RegExp(`/channels/${ticketChannel}/permissions/${IDS.mod}$`))).toHaveLength(1);
    await say('!ticket close erledigt', IDS.user, ticketChannel);
    expect(calls('DELETE', new RegExp(`/channels/${ticketChannel}$`))).toHaveLength(1);
    const log = calls('POST', new RegExp(`/channels/${CH2}/messages$`)).at(-1)!;
    expect(log.options!.files?.[0]?.name).toBe('ticket-1.txt');
  });
});

describe('levelup + badges', () => {
  it('Nachricht gibt XP; Level-Aufstieg vergibt Auto-Abzeichen und Level-Rolle', async () => {
    await say('Hallo zusammen', IDS.user);
    const lv = tb.bot.cogApi<{ stats: (g: string, u: string) => { xp: number; level: number; messages: number } }>('levelup')!;
    expect(lv.stats(IDS.guild, IDS.user).xp).toBeGreaterThanOrEqual(15);
    await say('!badgeset create Starter ⭐ Level 1 erreicht', IDS.admin);
    await say('!badgeset autolevel starter 1', IDS.admin);
    await say(`!levelset role add 1 <@&${IDS.roleMember}>`, IDS.admin);
    await say(`!levelset addxp <@${IDS.mod}> 150`, IDS.admin);
    expect(lv.stats(IDS.guild, IDS.mod).level).toBe(1);
    await flush(40);
    const badges = tb.bot.cogs.loaded.get('badges')!.config.member(IDS.guild, IDS.mod).get<string[]>('badges');
    expect(badges).toEqual(['starter']);
    await say(`!profile <@${IDS.mod}>`, IDS.user);
    expect(JSON.stringify(tb.rest.calls.at(-1)!.options!.body)).toContain('⭐');
  });
});

describe('trivia, bingo', () => {
  it('Trivia-Runde bis zum Sieg', async () => {
    const trivia = tb.bot.cogs.loaded.get('trivia')!;
    trivia.config.guild(IDS.guild).setAll({ maxScore: 1, timeout: 5, delay: 0 });
    await say('!trivia allgemeinwissen', IDS.user);
    await waitFor(() => texts().some((t) => t.startsWith('**Frage 1:**')));
    const question = texts().find((t) => t.startsWith('**Frage 1:**'))!.replace('**Frage 1:** ', '');
    const lists = JSON.parse(fs.readFileSync('cogs/trivia/lists/allgemeinwissen.json', 'utf8')) as { questions: Array<{ question: string; answers: string[] }> };
    const answer = lists.questions.find((q) => q.question === question)!.answers[0]!;
    await say('falsche Antwort xyz', IDS.mod);
    await say(answer, IDS.user);
    await waitFor(() => texts().some((t) => t.includes('Ergebnis')));
    expect(texts().some((t) => t.includes('Richtig'))).toBe(true);
    expect(trivia.config.member(IDS.guild, IDS.user).get('wins')).toBe(1);
  });

  it('Bingo: Karte, Reihe markieren, BINGO', async () => {
    const tiles = Array.from({ length: 24 }, (_, i) => `Ereignis ${i + 1}`).join('; ');
    await say(`!bingoset tiles ${tiles}`, IDS.admin);
    await say('!bingo', IDS.user);
    expect(last()).toContain('⭐');
    for (const cell of ['B3', 'I3', 'G3', 'O3']) await say(`!bingo mark ${cell}`, IDS.user);
    expect(texts().some((t) => t.includes('BINGO'))).toBe(true);
  });
});

describe('eventposter, general, conversions', () => {
  it('Event anlegen und per Reaktion anmelden', async () => {
    await say('!event create in 2h | Spieleabend | Among Us', IDS.user);
    const post = calls('POST', new RegExp(`/channels/${IDS.channel}/messages$`)).at(-1)!;
    expect(JSON.stringify(post.options!.body)).toContain('Spieleabend');
    const idx = tb.rest.calls.filter((c) => c.method === 'POST' && /\/messages$/.test(c.route)).indexOf(post);
    tb.platform.handleDispatch('MESSAGE_REACTION_ADD', { message_id: String(1000 + idx), channel_id: IDS.channel, guild_id: IDS.guild, user_id: IDS.mod, emoji: { name: '✅' } });
    await flush(40);
    const ev = Object.values(tb.bot.cogs.loaded.get('eventposter')!.config.guild(IDS.guild).get<Record<string, { participants: string[] }>>('events'))[0]!;
    expect(ev.participants).toEqual([IDS.user, IDS.mod]);
  });

  it('Allgemeine Befehle und Umrechnung (offline)', async () => {
    await say('!8ball Wird das klappen?');
    expect(last()).toMatch(/^🎱/);
    await say('!choose Pizza Pasta');
    expect(last()).toMatch(/Pizza|Pasta/);
    await say('!convert 5 km mi');
    expect(last()).toContain('3,1069 mi');
    await say('!convert 100 °F in °C');
    expect(last()).toContain('37,7778 °C');
  });
});

describe('instadl', () => {
  it('lädt über yt-dlp herunter und lädt die Datei hoch', async () => {
    const dir = tempDir();
    const fake = path.join(dir, 'yt-dlp');
    // Fake-yt-dlp: legt eine Datei gemäß -o-Vorlage an und schreibt den Titel
    fs.writeFileSync(
      fake,
      `#!/usr/bin/env node
const a = process.argv.slice(2);
const out = a[a.indexOf('-o') + 1].replace('%(playlist_index|0)s', '1').replace('%(id)s', 'ABC').replace('%(ext)s', 'mp4');
require('fs').writeFileSync(out, 'video');
const pf = a.indexOf('--print-to-file');
require('fs').writeFileSync(a[pf + 2], 'Mein Reel\\n');
`,
    );
    fs.chmodSync(fake, 0o755);
    process.env.YTDLP_PATH = fake;
    await tb.bot.cogs.reload('instadl');
    await say('!insta https://www.instagram.com/reel/ABC/', IDS.user);
    await waitFor(() => calls('POST', new RegExp(`/channels/${IDS.channel}/messages$`)).length > 0, 10_000);
    const post = calls('POST', new RegExp(`/channels/${IDS.channel}/messages$`)).at(-1)!;
    expect(post.options!.files?.[0]?.name).toBe('ABC.mp4');
    expect((post.options!.body as { content: string }).content).toContain('Mein Reel');
    delete process.env.YTDLP_PATH;
  });
});

describe('Hilfe mit Phase-3-Cogs', () => {
  it('Embed-Limits werden eingehalten', async () => {
    for (const q of ['!help', '!help economy', '!help levelset', '!help trivia', '!help event create', '!help streamalert']) {
      const before = tb.rest.calls.length;
      await say(q, IDS.botOwner);
      const sent = tb.rest.calls.slice(before).filter((c) => c.method === 'POST' && /\/messages$/.test(c.route));
      expect(sent.length, q).toBeGreaterThan(0);
      for (const c of sent) {
        for (const e of (c.options!.body as { embeds?: Array<{ description?: string; fields?: Array<{ value: string }> }> }).embeds ?? []) {
          expect((e.description ?? '').length).toBeLessThanOrEqual(4096);
          for (const f of e.fields ?? []) expect(f.value.length).toBeLessThanOrEqual(1024);
        }
      }
    }
  });
});
