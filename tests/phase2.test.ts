import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flush, IDS, makeBot, makeMessage, seedGuild, type RestCall, type TestBot } from './helpers.js';
import { checkStatic, DEFAULT_RULES } from '../cogs/automod/index.js';
import { buildMatcher } from '../cogs/filter/index.js';
import { extractInviteCodes } from '../cogs/inviteblocklist/index.js';
import { compilePattern, renderResponse } from '../cogs/retrigger/index.js';
import { parseColor } from '../cogs/admin/index.js';

const PHASE2 = [
  'modlog',
  'mod',
  'mutes',
  'warnings',
  'cleanup',
  'filter',
  'automod',
  'retrigger',
  'inviteblocklist',
  'reports',
  'roletools',
  'alias',
  'admin',
  'extendedmodlog',
];
const MODLOG_CHANNEL = '500000000000000020';

let tb: TestBot;
beforeEach(async () => {
  tb = await makeBot({ withBuiltinCogs: true });
  seedGuild(tb.platform);
  tb.platform.guilds.get(IDS.guild)!.channels.set(MODLOG_CHANNEL, { id: MODLOG_CHANNEL, type: 0, name: 'modlog', guild_id: IDS.guild } as never);
  tb.bot.core.guild(IDS.guild).set('modRoles', [IDS.roleMod]);
  for (const c of PHASE2) if (!tb.bot.cogs.isLoaded(c)) await tb.bot.cogs.load(c);
});
afterEach(async () => {
  tb.bot.scheduler.stopAll();
  await tb.bot.cogs.unloadAll();
});

/** Nachricht über das Gateway „empfangen“ (Dispatcher + alle Cog-Listener). */
async function say(content: string, author = IDS.user, extra: Record<string, unknown> = {}): Promise<void> {
  tb.platform.handleDispatch('MESSAGE_CREATE', { ...makeMessage(content, author), ...extra });
  await flush(40);
}
const calls = (method: string, re: RegExp): RestCall[] => tb.rest.calls.filter((c) => c.method === method && re.test(c.route));
const lastText = () => tb.rest.sentTexts().at(-1) ?? '';

describe('Phase 2: alle Cogs', () => {
  it('laden ohne Befehlskonflikte', () => {
    for (const c of PHASE2) expect(tb.bot.cogs.isLoaded(c)).toBe(true);
    const names = new Set<string>();
    for (const cmd of tb.bot.registry.all()) {
      for (const n of [cmd.name, ...(cmd.aliases ?? [])]) {
        expect(names.has(n), `doppelt: ${n}`).toBe(false);
        names.add(n);
      }
    }
  });
});

describe('mod + modlog', () => {
  it('kick durch Mod: API-Aufruf, Fall angelegt und im ModLog gepostet', async () => {
    tb.bot.cogs.loaded.get('modlog')!.config.guild(IDS.guild).set('channel', MODLOG_CHANNEL);
    await say(`!kick <@${IDS.user}> Spam`, IDS.mod);
    expect(calls('DELETE', new RegExp(`/guilds/${IDS.guild}/members/${IDS.user}$`))).toHaveLength(1);
    const posted = calls('POST', new RegExp(`/channels/${MODLOG_CHANNEL}/messages`));
    expect(posted).toHaveLength(1);
    expect(JSON.stringify(posted[0]!.options!.body)).toContain('Fall #1 | Kick');
    expect(lastText()).toContain('wurde gekickt');
  });

  it('Hierarchie: Mod kann Admin nicht kicken', async () => {
    await say(`!kick <@${IDS.admin}>`, IDS.mod);
    expect(calls('DELETE', /\/members\//)).toHaveLength(0);
    expect(lastText()).toMatch(/Rolle/);
  });

  it('ban per ID eines Nicht-Mitglieds wird als hackban geloggt; Tage werden übernommen', async () => {
    await say('!ban 299999999999999999 2 Ban-Umgehung', IDS.admin);
    const ban = calls('PUT', /\/bans\/299999999999999999$/)[0]!;
    expect((ban.options!.body as { delete_message_seconds: number }).delete_message_seconds).toBe(2 * 86400);
    const api = tb.bot.cogApi<{ casesFor: (g: string, u: string) => Array<{ action: string; reason: string }> }>('modlog')!;
    expect(api.casesFor(IDS.guild, '299999999999999999')[0]).toMatchObject({ action: 'hackban', reason: 'Ban-Umgehung' });
  });

  it('tempban läuft ab und wird automatisch aufgehoben', async () => {
    await say(`!tempban <@${IDS.user}> 1h Test`, IDS.admin);
    const mod = tb.bot.cogs.loaded.get('mod')!;
    mod.config.custom('tempban', IDS.guild, IDS.user).set('until', Date.now() - 1000);
    await tb.bot.scheduler.runNow('cog:mod', 'tempban-ablauf');
    expect(calls('DELETE', new RegExp(`/bans/${IDS.user}$`))).toHaveLength(1);
  });

  it('timeout setzt communication_disabled_until', async () => {
    await say(`!timeout <@${IDS.user}> 10m laut`, IDS.mod);
    const patch = calls('PATCH', new RegExp(`/members/${IDS.user}$`))[0]!;
    const until = new Date((patch.options!.body as { communication_disabled_until: string }).communication_disabled_until).getTime();
    expect(until - Date.now()).toBeGreaterThan(9 * 60_000);
  });

  it('reason ändert den Grund des letzten eigenen Falls', async () => {
    await say(`!kick <@${IDS.user}>`, IDS.mod);
    await say('!reason Nachgetragen', IDS.mod);
    const api = tb.bot.cogApi<{ getCase: (g: string, n: number) => { reason: string } }>('modlog')!;
    expect(api.getCase(IDS.guild, 1).reason).toBe('Nachgetragen');
  });
});

describe('mutes', () => {
  it('ohne Mute-Rolle per Timeout, unmute hebt auf', async () => {
    await say(`!mute <@${IDS.user}> 30m Spam`, IDS.mod);
    expect(calls('PATCH', new RegExp(`/members/${IDS.user}$`))).toHaveLength(1);
    await say(`!unmute <@${IDS.user}>`, IDS.mod);
    const patches = calls('PATCH', new RegExp(`/members/${IDS.user}$`));
    expect((patches.at(-1)!.options!.body as { communication_disabled_until: null }).communication_disabled_until).toBeNull();
  });

  it('mit Mute-Rolle wird die Rolle vergeben und nach Ablauf entfernt', async () => {
    tb.bot.cogs.loaded.get('mutes')!.config.guild(IDS.guild).set('muteRole', IDS.roleMember);
    await say(`!mute <@${IDS.user}> 5m`, IDS.mod);
    expect(calls('PUT', new RegExp(`/members/${IDS.user}/roles/${IDS.roleMember}$`))).toHaveLength(1);
    tb.bot.cogs.loaded.get('mutes')!.config.custom('mute', IDS.guild, IDS.user).set('until', Date.now() - 1);
    await tb.bot.scheduler.runNow('cog:mutes', 'mute-ablauf');
    expect(calls('DELETE', new RegExp(`/members/${IDS.user}/roles/${IDS.roleMember}$`))).toHaveLength(1);
  });

  it('channelmute setzt ein Mitglieds-Overwrite', async () => {
    await say(`!channelmute <@${IDS.user}>`, IDS.mod);
    const put = calls('PUT', new RegExp(`/channels/${IDS.channel}/permissions/${IDS.user}$`))[0]!;
    expect((put.options!.body as { type: number }).type).toBe(1);
  });
});

describe('warnings', () => {
  it('eskaliert ab der Punkteschwelle (kick)', async () => {
    await say('!warnaction add stufe1 3 kick', IDS.admin);
    await say(`!warn <@${IDS.user}> 2 Erste`, IDS.mod);
    expect(calls('DELETE', new RegExp(`/members/${IDS.user}$`))).toHaveLength(0);
    await say(`!warn <@${IDS.user}> Zweite`, IDS.mod);
    expect(calls('DELETE', new RegExp(`/members/${IDS.user}$`))).toHaveLength(1);
    const api = tb.bot.cogApi<{ totalPoints: (g: string, u: string) => number }>('warnings')!;
    expect(api.totalPoints(IDS.guild, IDS.user)).toBe(3);
  });

  it('vordefinierte Gründe liefern Punkte und Text', async () => {
    await say('!warnreason add werbung 4 Werbung für andere Server', IDS.admin);
    await say(`!warn <@${IDS.user}> werbung`, IDS.mod);
    expect(lastText()).toContain('+4 P.');
  });

  it('normale Mitglieder sehen nur eigene Verwarnungen', async () => {
    await say(`!warnings <@${IDS.mod}>`, IDS.user);
    expect(lastText()).toMatch(/nur deine eigenen/);
  });
});

describe('filter, automod, inviteblocklist', () => {
  it('Filter löscht Treffer, aber nicht bei Mods', async () => {
    await say('!filter add böse*', IDS.mod);
    const before = calls('DELETE', /\/messages\/\d+$/).length;
    await say('Du Bösewicht!', IDS.user);
    expect(calls('DELETE', /\/messages\/\d+$/).length).toBe(before + 1);
    await say('Du Bösewicht!', IDS.mod);
    expect(calls('DELETE', /\/messages\/\d+$/).length).toBe(before + 1);
  });

  it('Matcher: ganze Wörter, Platzhalter, Unicode', () => {
    const m = buildMatcher(['spam', 'böse*'])!;
    expect(m.test('kein spamming')).toBe(false);
    expect(m.test('SPAM!')).toBe(true);
    expect(m.test('bösewicht')).toBe(true);
    expect(buildMatcher([])).toBeNull();
  });

  it('Automod: Spam führt zu Timeout', async () => {
    await say('!automod toggle an', IDS.admin);
    for (let i = 0; i < 6; i++) await say(`nachricht ${i}`, IDS.user);
    const patch = calls('PATCH', new RegExp(`/members/${IDS.user}$`));
    expect(patch).toHaveLength(1);
    expect(patch[0]!.options!.body).toHaveProperty('communication_disabled_until');
  });

  it('Automod-Regeln (statisch)', () => {
    const rules = structuredClone(DEFAULT_RULES);
    rules.caps!.enabled = true;
    rules.links!.enabled = true;
    rules.links!.allow = ['youtube.com'];
    expect(checkStatic(rules, { content: 'DAS IST ALLES GROSS GESCHRIEBEN', mentions: [] } as never)).toBe('caps');
    expect(checkStatic(rules, { content: 'schau https://www.youtube.com/watch', mentions: [] } as never)).toBeNull();
    expect(checkStatic(rules, { content: 'schau https://evil.example/x', mentions: [] } as never)).toBe('links');
    const mentions = Array.from({ length: 6 }, (_, i) => ({ id: String(i) }));
    expect(checkStatic(rules, { content: 'hi', mentions } as never)).toBe('mentions');
  });

  it('Einladungssperre löscht fremde Einladungen', async () => {
    tb.rest.handler = (c) => (c.route.startsWith('/invites/') ? { code: 'abc', guild: { id: '999999999999999999', name: 'Fremd' } } : undefined);
    await say('!inviteblock toggle an', IDS.admin);
    await say('Kommt alle auf fluxer.gg/abc123', IDS.user);
    expect(calls('DELETE', /\/messages\/\d+$/).length).toBeGreaterThanOrEqual(1);
    expect(extractInviteCodes('https://chat.example.test/invite/XyZ und discord.gg/abc', 'chat.example.test')).toEqual(['XyZ', 'abc']);
  });
});

describe('cleanup, retrigger, alias', () => {
  it('cleanup messages nutzt Bulk-Delete', async () => {
    const msgs = Array.from({ length: 5 }, (_, i) => ({ id: String(800000000000000100n + BigInt(i)), timestamp: new Date().toISOString(), author: { id: IDS.user }, content: 'x' }));
    tb.rest.handler = (c) => (c.method === 'GET' && /\/messages\?/.test(c.route) ? msgs : undefined);
    await say('!cleanup messages 5', IDS.mod);
    const bulk = calls('POST', /bulk-delete$/)[0]!;
    expect((bulk.options!.body as { messages: string[] }).messages).toHaveLength(6); // 5 + Befehl
  });

  it('retrigger antwortet mit Platzhaltern', async () => {
    await say('!retrigger text gruss "(?i)^moin$" Moin {user}!', IDS.admin);
    await say('MOIN', IDS.user);
    expect(lastText()).toBe(`Moin <@${IDS.user}>!`);
    expect(() => compilePattern('(a+)+$')).toThrow();
    const match = /(\w+) (\w+)/.exec('hallo welt')!;
    expect(renderResponse('{1}-{2} {count}', { author: { id: '1', username: 'x' }, channel_id: '2' } as never, match, { server: 's', count: 3 })).toBe('hallo-welt 3');
  });

  it('alias führt den Zielbefehl aus', async () => {
    await say('!alias add up uptime', IDS.mod);
    await say('!up', IDS.user);
    expect(lastText()).toMatch(/Online seit/);
  });
});

describe('reports, roletools, admin, extendedmodlog', () => {
  it('report landet im Team-Kanal, ✅ eines Mods markiert erledigt', async () => {
    await say(`!reportset output <#${MODLOG_CHANNEL}>`, IDS.admin);
    await say(`!report <@${IDS.mod}> ist gemein`, IDS.user);
    const post = calls('POST', new RegExp(`/channels/${MODLOG_CHANNEL}/messages$`))[0]!;
    expect(JSON.stringify(post.options!.body)).toContain('ist gemein');
    // FakeRest vergibt Nachrichten-IDs fortlaufend ab 1000
    const created = tb.rest.calls.filter((c) => c.method === 'POST' && /\/messages$/.test(c.route));
    const idx = created.indexOf(post);
    tb.platform.handleDispatch('MESSAGE_REACTION_ADD', {
      message_id: String(1000 + idx),
      channel_id: MODLOG_CHANNEL,
      guild_id: IDS.guild,
      user_id: IDS.mod,
      emoji: { name: '✅' },
    });
    await flush(40);
    expect(calls('PATCH', new RegExp(`/channels/${MODLOG_CHANNEL}/messages/`))).toHaveLength(1);
  });

  it('Reaktionsrolle vergibt und entfernt die Rolle', async () => {
    await say(`!roletools reaction add ${IDS.channel}-700000000000099999 🎮 <@&${IDS.roleMember}>`, IDS.admin);
    expect(lastText()).toContain('Mitglied');
    const ev = { message_id: '700000000000099999', channel_id: IDS.channel, guild_id: IDS.guild, user_id: IDS.mod, emoji: { name: '🎮' } };
    // moritz hat die Rolle schon → kein PUT; nutzer ohne Rolle: Rolle wird vergeben
    tb.platform.handleDispatch('MESSAGE_REACTION_ADD', { ...ev, user_id: IDS.admin });
    await flush(40);
    expect(calls('PUT', new RegExp(`/members/${IDS.admin}/roles/${IDS.roleMember}$`))).toHaveLength(1);
    tb.platform.handleDispatch('MESSAGE_REACTION_REMOVE', { ...ev, user_id: IDS.admin });
    await flush(40);
    expect(calls('DELETE', new RegExp(`/members/${IDS.admin}/roles/${IDS.roleMember}$`))).toHaveLength(1);
  });

  it('Auto-Rolle beim Beitritt', async () => {
    await say(`!roletools auto <@&${IDS.roleMember}> an`, IDS.admin);
    tb.platform.handleDispatch('GUILD_MEMBER_ADD', { guild_id: IDS.guild, user: { id: '200000000000000050', username: 'neu' }, roles: [] });
    await flush(40);
    expect(calls('PUT', new RegExp(`/members/200000000000000050/roles/${IDS.roleMember}$`))).toHaveLength(1);
  });

  it('addrole und Farbparser', async () => {
    await say(`!addrole <@&${IDS.roleMember}> <@${IDS.mod}>`, IDS.admin);
    expect(calls('PUT', new RegExp(`/members/${IDS.mod}/roles/${IDS.roleMember}$`))).toHaveLength(1);
    expect(parseColor('#ff8800')).toBe(0xff8800);
    expect(parseColor('f80')).toBe(0xff8800);
    expect(parseColor('rot')).toBe(0xe74c3c);
    expect(parseColor('kaputt')).toBeUndefined();
  });

  it('extendedmodlog loggt gelöschte Nachrichten mit Inhalt aus dem Cache', async () => {
    await say(`!extmodlog channel <#${MODLOG_CHANNEL}>`, IDS.admin);
    await say('!extmodlog toggle messageDelete an', IDS.admin);
    const msg = makeMessage('geheimer Inhalt', IDS.user);
    tb.platform.handleDispatch('MESSAGE_CREATE', msg);
    tb.platform.handleDispatch('MESSAGE_DELETE', { id: msg.id, channel_id: msg.channel_id, guild_id: IDS.guild });
    await flush(40);
    const log = calls('POST', new RegExp(`/channels/${MODLOG_CHANNEL}/messages$`)).at(-1)!;
    expect(JSON.stringify(log.options!.body)).toContain('geheimer Inhalt');
  });
});

describe('Hilfe mit allen Cogs', () => {
  it('!help, !help <cog> und !help <gruppe> funktionieren und halten Embed-Limits ein', async () => {
    for (const q of ['!help', '!help mod', '!help automod', '!help roletools reaction', '!help extmodlog']) {
      const before = tb.rest.calls.length;
      await say(q, IDS.botOwner);
      const sent = tb.rest.calls.slice(before).filter((c) => c.method === 'POST' && /\/messages$/.test(c.route));
      expect(sent.length, q).toBeGreaterThan(0);
      for (const c of sent) {
        for (const e of ((c.options!.body as { embeds?: Array<{ description?: string; fields?: Array<{ value: string }> }> }).embeds ?? [])) {
          expect((e.description ?? '').length).toBeLessThanOrEqual(4096);
          for (const f of e.fields ?? []) expect(f.value.length).toBeLessThanOrEqual(1024);
        }
      }
    }
  });
});
