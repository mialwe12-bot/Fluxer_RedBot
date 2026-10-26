import { describe, expect, it } from 'vitest';
import { parseArgs, tokenize, usageOf, type ParseEnvironment } from '../src/commands/parser.js';
import { CooldownManager } from '../src/commands/cooldowns.js';
import { CommandRegistry } from '../src/commands/registry.js';
import { OptionType, toApplicationCommand } from '../src/commands/types.js';
import { I18n } from '../src/i18n/i18n.js';
import { pagify, parseDuration, humanizeSeconds } from '../src/utils/format.js';
import { IDS, makeBot, makeMessage, seedGuild } from './helpers.js';

describe('Tokenizer und Parser', () => {
  it('berücksichtigt Anführungszeichen (auch deutsche)', () => {
    expect(tokenize('a "b c" „d e“ f').map((t) => t.value)).toEqual(['a', 'b c', 'd e', 'f']);
  });

  it('wandelt Typen um und meldet Fehler', async () => {
    const { platform } = await makeBot();
    seedGuild(platform);
    const env: ParseEnvironment = { guild: platform.getGuild(IDS.guild), users: platform.users, attachments: [] };
    const opts = [
      { name: 'n', description: '', type: OptionType.Integer, required: true, min_value: 1, max_value: 10 },
      { name: 'an', description: '', type: OptionType.Boolean, required: true },
      { name: 'wer', description: '', type: OptionType.User, required: true },
      { name: 'rolle', description: '', type: OptionType.Role, required: true },
      { name: 'kanal', description: '', type: OptionType.Channel, required: true },
      { name: 'grund', description: '', type: OptionType.String },
    ];
    const r = parseArgs(opts, `5 ja <@${IDS.mod}> mods #allgemein weil "das" so ist`, env);
    expect(r.n).toBe(5);
    expect(r.an).toBe(true);
    expect((r.wer as { id: string }).id).toBe(IDS.mod);
    expect((r.rolle as { id: string }).id).toBe(IDS.roleMod);
    expect((r.kanal as { id: string }).id).toBe(IDS.channel);
    expect(r.grund).toBe('weil "das" so ist');
    expect(() => parseArgs(opts, '11 ja x y z', env)).toThrowError(/maxValue/);
    expect(() => parseArgs(opts, '5', env)).toThrowError(/missing/);
    // Benutzer per Name
    expect((parseArgs([opts[2]!], 'nutzer', env).wer as { id: string }).id).toBe(IDS.user);
  });

  it('Choices, variadic, rest und Defaults', () => {
    const env: ParseEnvironment = { guild: undefined, users: new Map(), attachments: [] };
    const r = parseArgs(
      [
        { name: 'modus', description: '', type: OptionType.String, required: true, choices: [{ name: 'an', value: 'on' }, { name: 'aus', value: 'off' }] },
        { name: 'zahlen', description: '', type: OptionType.Integer, variadic: true },
      ],
      'AN 1 2 3',
      env,
    );
    expect(r).toEqual({ modus: 'on', zahlen: [1, 2, 3] });
    expect(() => parseArgs([{ name: 'm', description: '', type: OptionType.String, required: true, choices: [{ name: 'a', value: 'a' }] }], 'b', env)).toThrow();
    expect(parseArgs([{ name: 'x', description: '', type: OptionType.Integer, default: 7 }], '', env)).toEqual({ x: 7 });
    expect(usageOf([{ name: 'a', description: '', type: OptionType.String, required: true }, { name: 'b', description: '', type: OptionType.String }])).toBe('<a> [b]');
  });
});

describe('Registry', () => {
  it('löst Gruppen, Unterbefehle und Aliase auf', () => {
    const reg = new CommandRegistry();
    reg.register(
      { name: 'set', description: 'x', subcommands: [{ name: 'name', description: 'y', aliases: ['n'], run: () => {} }] },
      'core',
      'Core',
    );
    const r = reg.resolve('set n  Neuer Name ');
    expect(r?.command.qualifiedName).toBe('set name');
    expect(r?.argString).toBe('Neuer Name');
    expect(reg.find('set name')?.qualifiedName).toBe('set name');
    expect(() => reg.register({ name: 'x', aliases: ['set'], description: 'z' }, 'other', 'Other')).toThrow(/kollidiert/);
    expect(reg.unregisterCog('core')).toBe(1);
    expect(reg.resolve('set name')).toBeUndefined();
  });

  it('erzeugt Slash-Command-JSON aus der internen Definition', () => {
    const json = toApplicationCommand({
      name: 'kick',
      description: 'Kickt',
      guildOnly: true,
      permissions: { level: 'mod', member: ['KickMembers'] },
      options: [{ name: 'user', description: 'wer', type: OptionType.User, required: true, rest: true }],
    });
    expect(json).toMatchObject({ name: 'kick', dm_permission: false, default_member_permissions: '2' });
    expect((json.options as Array<Record<string, unknown>>)[0]).toEqual({ name: 'user', description: 'wer', type: 6, required: true });
  });
});

describe('Cooldowns', () => {
  it('erlaubt rate Aufrufe pro Zeitfenster', () => {
    let now = 0;
    const cd = new CooldownManager(() => now);
    const spec = { rate: 2, per: 10 };
    const who = { userId: 'u', channelId: 'c' };
    expect(cd.hit('x', spec, who)).toBe(0);
    expect(cd.hit('x', spec, who)).toBe(0);
    expect(cd.hit('x', spec, who)).toBeCloseTo(10);
    expect(cd.hit('x', spec, { userId: 'v', channelId: 'c' })).toBe(0);
    now = 10_001;
    expect(cd.hit('x', spec, who)).toBe(0);
  });
});

describe('Dispatcher (Ende-zu-Ende)', () => {
  it('reagiert auf Prefix und Erwähnung, prüft Rechte und Cooldowns', async () => {
    const { bot, rest, platform } = await makeBot();
    seedGuild(platform);
    let notFound = '';
    bot.events.on('commandNotFound', (e: { text: string }) => (notFound = e.text));
    await bot.dispatcher.handleMessage(makeMessage('!uptime'));
    expect(rest.sentTexts().at(-1)).toMatch(/Online seit/);
    await bot.dispatcher.handleMessage(makeMessage(`<@${IDS.bot}> uptime`));
    expect(rest.sentTexts()).toHaveLength(2);
    await bot.dispatcher.handleMessage(makeMessage('!gibtsnicht 1 2'));
    expect(notFound).toBe('gibtsnicht 1 2');
    // Serverprefix ändern: nur Admins
    await bot.dispatcher.handleMessage(makeMessage('!prefix set ?', IDS.user));
    expect(rest.sentTexts().at(-1)).toMatch(/Administrator/);
    await bot.dispatcher.handleMessage(makeMessage('!prefix set ?', IDS.admin));
    expect(bot.prefixesFor(IDS.guild)).toEqual(['?']);
    await bot.dispatcher.handleMessage(makeMessage('?uptime'));
    expect(rest.sentTexts().at(-1)).toMatch(/Online seit/);
    // Cooldown von ping: 3 pro 10 s pro Kanal
    for (let i = 0; i < 4; i++) await bot.dispatcher.handleMessage(makeMessage('?ping'));
    expect(rest.sentTexts().at(-1)).toMatch(/Langsam/);
  });

  it('zeigt Hilfe, Verwendung bei falschen Argumenten und Gruppenhilfe', async () => {
    const { bot, rest, platform } = await makeBot();
    seedGuild(platform);
    await bot.dispatcher.handleMessage(makeMessage('!help'));
    expect(rest.sentTexts().at(-1)).toMatch(/Hilfe für TestBot/);
    await bot.dispatcher.handleMessage(makeMessage('!set'));
    expect(rest.sentTexts().at(-1)).toMatch(/!set <unterbefehl>/);
    await bot.dispatcher.handleMessage(makeMessage('!traceback abc', IDS.botOwner));
    expect(rest.sentTexts().at(-1)).toMatch(/keine ganze Zahl|keine Zahl/);
    expect(rest.sentTexts().at(-1)).toMatch(/Verwendung/);
  });

  it('fällt bei deaktivierten Embeds auf Text zurück', async () => {
    const { bot, rest, platform } = await makeBot();
    seedGuild(platform);
    bot.core.guild(IDS.guild).set('embeds', false);
    await bot.dispatcher.handleMessage(makeMessage('!info'));
    const body = rest.calls.at(-1)!.options!.body as { content?: string; embeds?: unknown[] };
    expect(body.embeds).toBeUndefined();
    expect(body.content).toMatch(/\*\*Über TestBot\*\*/);
  });
});

describe('i18n und Formatierung', () => {
  it('Platzhalter, Plural, Fallback auf Deutsch und Schlüssel', () => {
    const i = new I18n('en');
    i.addBundle('x', 'de', { a: 'Hallo {name}', n: { one: '{count} Datei', other: '{count} Dateien' } });
    i.addBundle('x', 'en', { a: 'Hello {name}' });
    expect(i.t('x', 'a', { name: 'Welt' })).toBe('Hello Welt');
    expect(i.t('x', 'n', { count: 1 })).toBe('1 Datei');
    expect(i.t('x', 'n', { count: 3 })).toBe('3 Dateien');
    expect(i.t('x', 'fehlt')).toBe('fehlt');
    // gettext-Stil: deutscher Originaltext als Schlüssel
    i.addBundle('x', 'en', { a: 'Hello {name}', 'Lädt Cogs.': 'Loads cogs.' });
    expect(i.t('x', 'Lädt Cogs.')).toBe('Loads cogs.');
    const de = new I18n('de');
    de.addBundle('x', 'en', { 'Lädt Cogs.': 'Loads cogs.' });
    expect(de.t('x', 'Lädt Cogs.')).toBe('Lädt Cogs.');
    expect(de.t('x', 'Lädt Cogs.', {}, 'en')).toBe('Loads cogs.');
  });

  it('parseDuration / humanizeSeconds / pagify', () => {
    expect(parseDuration('1h30m')).toBe(5400);
    expect(parseDuration('2 tage')).toBe(172800);
    expect(parseDuration('10')).toBe(600);
    expect(parseDuration('quatsch')).toBeUndefined();
    expect(humanizeSeconds(3725)).toBe('1 Stunde, 2 Minuten und 5 Sekunden');
    const pages = pagify('zeile\n'.repeat(1000), { pageLength: 100 });
    expect(pages.every((p) => p.length <= 100)).toBe(true);
  });
});
