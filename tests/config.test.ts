import { describe, expect, it } from 'vitest';
import { Config, ConfigError, ConfigStore } from '../src/config/config.js';
import { openDatabase } from '../src/db/database.js';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers.js';

function setup() {
  const db = openDatabase(':memory:');
  const store = new ConfigStore(db);
  return { db, store, config: new Config(store, 'testcog') };
}

describe('Config-API', () => {
  it('liefert registrierte Defaults und speichert Werte pro Scope', () => {
    const { config } = setup();
    config.registerGuild({ enabled: false, channel: null, words: [] as string[] });
    expect(config.guild('1').get('enabled')).toBe(false);
    expect(config.guild('1').get('channel')).toBeNull();
    config.guild('1').set('enabled', true);
    expect(config.guild('1').get('enabled')).toBe(true);
    expect(config.guild('2').get('enabled')).toBe(false);
  });

  it('wirft bei nicht registrierten Schlüsseln, außer mit Fallback', () => {
    const { config } = setup();
    config.registerGlobal({ a: 1 });
    expect(() => config.global().get('tippfehler')).toThrow(ConfigError);
    expect(config.global().get('tippfehler', 42)).toBe(42);
  });

  it('gibt Kopien der Defaults zurück (keine geteilten Objekte)', () => {
    const { config } = setup();
    config.registerUser({ list: [] as string[] });
    const list = config.user('u').get<string[]>('list');
    list.push('x');
    expect(config.user('u').get('list')).toEqual([]);
    expect(config.user('other').get('list')).toEqual([]);
  });

  it('trennt Namensräume verschiedener Cogs', () => {
    const { store } = setup();
    const a = new Config(store, 'a').registerGlobal({ value: 0 });
    const b = new Config(store, 'b').registerGlobal({ value: 0 });
    a.global().set('value', 5);
    expect(a.global().get('value')).toBe(5);
    expect(b.global().get('value')).toBe(0);
  });

  it('unterstützt alle Scopes: global, guild, channel, role, member, user, custom', () => {
    const { config } = setup();
    config
      .registerGlobal({ v: 'g' })
      .registerGuild({ v: 'guild' })
      .registerChannel({ v: 'channel' })
      .registerRole({ v: 'role' })
      .registerMember({ v: 'member' })
      .registerUser({ v: 'user' })
      .registerCustom('reminder', { v: 'custom' });
    config.global().set('v', 'G');
    config.guild('1').set('v', 'GUILD');
    config.channel('1').set('v', 'CHANNEL');
    config.role('1').set('v', 'ROLE');
    config.member('1', '1').set('v', 'MEMBER');
    config.user('1').set('v', 'USER');
    config.custom('reminder', '1', 'abc').set('v', 'CUSTOM');
    expect([
      config.global().get('v'),
      config.guild('1').get('v'),
      config.channel('1').get('v'),
      config.role('1').get('v'),
      config.member('1', '1').get('v'),
      config.user('1').get('v'),
      config.custom('reminder', '1', 'abc').get('v'),
    ]).toEqual(['G', 'GUILD', 'CHANNEL', 'ROLE', 'MEMBER', 'USER', 'CUSTOM']);
    // gleiche ID in anderem Scope ist unabhängig
    expect(config.member('1', '2').get('v')).toBe('member');
  });

  it('update() liest, verändert und schreibt atomar', () => {
    const { config } = setup();
    config.registerMember({ xp: 0 });
    for (let i = 0; i < 5; i++) config.member('g', 'u').update<number>('xp', (xp) => xp + 10);
    expect(config.member('g', 'u').get('xp')).toBe(50);
  });

  it('all(), raw(), setAll() und clear()', () => {
    const { config } = setup();
    config.registerGuild({ a: 1, b: 2 });
    const g = config.guild('9');
    g.setAll({ a: 10 });
    expect(g.all()).toEqual({ a: 10, b: 2 });
    expect(g.raw()).toEqual({ a: 10 });
    expect(g.has('a')).toBe(true);
    g.clear('a');
    expect(g.get('a')).toBe(1);
    g.set('b', 3);
    g.clear();
    expect(g.all()).toEqual({ a: 1, b: 2 });
  });

  it('allGuilds() und allMembers() gruppieren gespeicherte Daten', () => {
    const { config } = setup();
    config.registerGuild({ on: false, x: 1 });
    config.registerMember({ score: 0 });
    config.guild('1').set('on', true);
    config.guild('2').set('x', 5);
    config.member('1', 'a').set('score', 3);
    config.member('1', 'b').set('score', 4);
    config.member('2', 'a').set('score', 9);
    expect(config.allGuilds()).toEqual({ '1': { on: true, x: 1 }, '2': { on: false, x: 5 } });
    expect(config.allMembers('1')).toEqual({ '1': { a: { score: 3 }, b: { score: 4 } } });
    expect(Object.keys(config.allMembers())).toEqual(['1', '2']);
    config.clearAllMembers('1');
    expect(config.allMembers()).toEqual({ '2': { a: { score: 9 } } });
  });

  it('Guild-IDs mit LIKE-Sonderzeichen werden korrekt gefiltert', () => {
    const { config } = setup();
    config.registerMember({ v: 0 });
    config.member('1_', 'a').set('v', 1);
    config.member('12', 'a').set('v', 2);
    expect(Object.keys(config.allMembers('1_'))).toEqual(['1_']);
  });

  it('clearAll() löscht den ganzen Namensraum', () => {
    const { store } = setup();
    const a = new Config(store, 'a').registerGlobal({ v: 0 }).registerGuild({ v: 0 });
    const b = new Config(store, 'b').registerGlobal({ v: 0 });
    a.global().set('v', 1);
    a.guild('1').set('v', 1);
    b.global().set('v', 1);
    a.clearAll();
    expect(a.global().get('v')).toBe(0);
    expect(a.guild('1').get('v')).toBe(0);
    expect(b.global().get('v')).toBe(1);
  });

  it('bleibt über Neustarts erhalten (SQLite-Datei)', () => {
    const file = path.join(tempDir(), 'bot.sqlite');
    const db1 = openDatabase(file);
    new Config(new ConfigStore(db1), 'p').registerGlobal({ n: 0 }).global().set('n', 7);
    db1.close();
    const db2 = openDatabase(file);
    expect(new Config(new ConfigStore(db2), 'p').registerGlobal({ n: 0 }).global().get('n')).toBe(7);
    db2.close();
    expect(fs.existsSync(file)).toBe(true);
  });
});
