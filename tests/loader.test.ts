import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CogError } from '../src/cogs/loader.js';
import { flush, IDS, makeBot, makeMessage, seedGuild, writeCog, type TestBot } from './helpers.js';

const bots: TestBot[] = [];
async function bot(options: Parameters<typeof makeBot>[0] = {}) {
  const tb = await makeBot(options);
  bots.push(tb);
  return tb;
}
afterEach(async () => {
  for (const tb of bots.splice(0)) {
    tb.bot.scheduler.stopAll();
    await tb.bot.cogs.unloadAll();
  }
});

const simpleCog = (reply: string, extra = '') => `
import { defineCog, OptionType } from '@bot/sdk';
${extra}
export default defineCog({
  setup(cog) {
    cog.config.registerGlobal({ hits: 0 });
    cog.command({
      name: 'sag',
      description: 'Antwortet',
      aliases: ['say'],
      options: [{ name: 'text', description: 'Text', type: OptionType.String }],
      run: async (ctx) => {
        cog.config.global().update('hits', (n) => n + 1);
        await ctx.send('${reply}' + (ctx.arg('text') ? ':' + ctx.arg('text') : ''));
      },
    });
  },
});
`;

describe('Cog-Loader', () => {
  it('findet Cogs mit gültigem Manifest und ignoriert fehlerhafte', async () => {
    const { bot: b, cogsDir } = await bot();
    writeCog(cogsDir, 'alpha', simpleCog('a'));
    fs.mkdirSync(path.join(cogsDir, 'kaputt'));
    fs.writeFileSync(path.join(cogsDir, 'kaputt', 'manifest.json'), '{ kein json');
    writeCog(cogsDir, 'falsch', simpleCog('x'), { name: 'anders' });
    const found = b.cogs.discover();
    expect([...found.keys()]).toEqual(['alpha']);
  });

  it('lädt einen Cog, registriert Befehle (inkl. Alias) und führt sie aus', async () => {
    const { bot: b, cogsDir, rest, platform } = await bot();
    seedGuild(platform);
    writeCog(cogsDir, 'alpha', simpleCog('hallo'));
    await b.cogs.load('alpha');
    expect(b.cogs.isLoaded('alpha')).toBe(true);
    expect(b.registry.get('sag')?.cogName).toBe('alpha');
    expect(b.registry.get('say')?.name).toBe('sag');
    await b.dispatcher.handleMessage(makeMessage('!say Welt'));
    expect(rest.sentTexts()).toContain('hallo:Welt');
  });

  it('Hot-Reload übernimmt geänderten Code inklusive Untermodulen – ohne Neustart', async () => {
    const { bot: b, cogsDir, rest, platform } = await bot();
    seedGuild(platform);
    const dir = writeCog(
      cogsDir,
      'beta',
      simpleCog('v1', "import { suffix } from './lib/text.js';").replace("'v1'", "'v1' + suffix"),
      {},
      { 'lib/text.ts': "export const suffix = '-a';" },
    );
    await b.cogs.load('beta');
    await b.dispatcher.handleMessage(makeMessage('!sag'));
    fs.writeFileSync(path.join(dir, 'lib', 'text.ts'), "export const suffix = '-b';");
    fs.writeFileSync(path.join(dir, 'index.ts'), simpleCog('v2', "import { suffix } from './lib/text.js';").replace("'v2'", "'v2' + suffix"));
    await b.cogs.reload('beta');
    await b.dispatcher.handleMessage(makeMessage('!sag'));
    expect(rest.sentTexts()).toEqual(['v1-a', 'v2-b']);
    // Config bleibt über Reloads erhalten
    expect(b.configStore.get('beta', 'global', '', 'hits')).toEqual({ found: true, value: 2 });
  });

  it('Entladen entfernt Befehle, Listener und Tasks', async () => {
    const { bot: b, cogsDir, platform } = await bot();
    writeCog(
      cogsDir,
      'gamma',
      `import { defineCog } from '@bot/sdk';
       export default defineCog({
         setup(cog) {
           cog.command({ name: 'gamma', description: 'x', run: () => {} });
           cog.on('TYPING_START', () => { (globalThis as any).__gammaEvents = ((globalThis as any).__gammaEvents ?? 0) + 1; });
           cog.schedule({ name: 'tick', every: 3600, run: () => {} });
         },
       });`,
    );
    await b.cogs.load('gamma');
    platform.handleDispatch('TYPING_START', {});
    expect((globalThis as any).__gammaEvents).toBe(1);
    expect(b.scheduler.list('cog:gamma')).toHaveLength(1);
    await b.cogs.unload('gamma');
    platform.handleDispatch('TYPING_START', {});
    expect((globalThis as any).__gammaEvents).toBe(1);
    expect(b.registry.get('gamma')).toBeUndefined();
    expect(b.scheduler.list('cog:gamma')).toHaveLength(0);
    expect(b.cogs.isLoaded('gamma')).toBe(false);
  });

  it('lädt Abhängigkeiten automatisch und verhindert Entladen benötigter Cogs', async () => {
    const { bot: b, cogsDir } = await bot();
    writeCog(cogsDir, 'basis', `import { defineCog } from '@bot/sdk'; export default defineCog(() => {});`);
    writeCog(cogsDir, 'aufbau', `import { defineCog } from '@bot/sdk'; export default defineCog(() => {});`, { dependencies: ['basis'] });
    const extra = await b.cogs.load('aufbau');
    expect(extra).toEqual(['basis']);
    expect(b.cogs.isLoaded('basis')).toBe(true);
    await expect(b.cogs.unload('basis')).rejects.toMatchObject({ key: 'cogs.errors.hasDependents' });
    // Reload der Basis lädt den abhängigen Cog wieder mit
    expect(await b.cogs.reload('basis')).toEqual(['aufbau']);
    expect(b.cogs.isLoaded('aufbau')).toBe(true);
  });

  it('meldet fehlende Abhängigkeiten und zirkuläre Abhängigkeiten', async () => {
    const { bot: b, cogsDir } = await bot();
    writeCog(cogsDir, 'einsam', `import { defineCog } from '@bot/sdk'; export default defineCog(() => {});`, { dependencies: ['gibtsnicht'] });
    writeCog(cogsDir, 'ping1', `import { defineCog } from '@bot/sdk'; export default defineCog(() => {});`, { dependencies: ['ping2'] });
    writeCog(cogsDir, 'ping2', `import { defineCog } from '@bot/sdk'; export default defineCog(() => {});`, { dependencies: ['ping1'] });
    await expect(b.cogs.load('einsam')).rejects.toMatchObject({ key: 'cogs.errors.missingDependency' });
    await expect(b.cogs.load('ping1')).rejects.toMatchObject({ key: 'cogs.errors.cycle' });
    expect(b.cogs.isLoaded('ping1') || b.cogs.isLoaded('ping2')).toBe(false);
  });

  it('rollt zurück, wenn setup() fehlschlägt oder ein Befehl kollidiert', async () => {
    const { bot: b, cogsDir } = await bot();
    writeCog(
      cogsDir,
      'fehler',
      `import { defineCog } from '@bot/sdk';
       export default defineCog((cog) => { cog.command({ name: 'fehlerbefehl', description: 'x', run: () => {} }); throw new Error('kaputt'); });`,
    );
    writeCog(cogsDir, 'konflikt', `import { defineCog } from '@bot/sdk'; export default defineCog((cog) => { cog.command({ name: 'help', description: 'x', run: () => {} }); });`);
    await expect(b.cogs.load('fehler')).rejects.toMatchObject({ key: 'cogs.errors.setup' });
    expect(b.registry.get('fehlerbefehl')).toBeUndefined();
    await expect(b.cogs.load('konflikt')).rejects.toBeInstanceOf(CogError);
    expect(b.registry.get('help')?.cogName).toBe('core');
    expect(b.cogs.isLoaded('konflikt')).toBe(false);
  });

  it('meldet Syntaxfehler verständlich', async () => {
    const { bot: b, cogsDir } = await bot();
    writeCog(cogsDir, 'syntax', `export default {{{`);
    await expect(b.cogs.load('syntax')).rejects.toMatchObject({ key: 'cogs.errors.build' });
  });

  it('Fehler in Listenern und Befehlen bringen den Bot nicht zum Absturz', async () => {
    const { bot: b, cogsDir, rest, platform } = await bot();
    seedGuild(platform);
    writeCog(
      cogsDir,
      'chaos',
      `import { defineCog } from '@bot/sdk';
       export default defineCog((cog) => {
         cog.on('TYPING_START', () => { throw new Error('sync'); });
         cog.on('TYPING_START', async () => { throw new Error('async'); });
         cog.command({ name: 'boom', description: 'x', run: () => { throw new Error('peng'); } });
       });`,
    );
    await b.cogs.load('chaos');
    expect(() => platform.handleDispatch('TYPING_START', {})).not.toThrow();
    await b.dispatcher.handleMessage(makeMessage('!boom'));
    await flush();
    expect(rest.sentTexts().some((t) => t.includes('unerwarteter Fehler'))).toBe(true);
    expect(b.recentErrors[0]?.command).toBe('boom');
  });

  it('merkt sich geladene Cogs und lädt sie beim nächsten Start wieder', async () => {
    const first = await bot();
    writeCog(first.cogsDir, 'merk', simpleCog('m'));
    await first.bot.cogs.load('merk');
    first.bot.rememberCogs(['merk'], true);
    expect(first.bot.core.global().get('loadedCogs')).toEqual(['merk']);
    // zweiter Bot mit derselben DB/Cog-Ordnern
    const second = await bot({ init: false });
    second.bot.core.global().set('loadedCogs', ['merk', 'fehltjetzt']);
    second.bot.core.global().set('initialized', true);
    writeCog(second.cogsDir, 'merk', simpleCog('m'));
    await second.bot.init();
    expect(second.bot.cogs.isLoaded('merk')).toBe(true);
    // fehlgeschlagene Cogs bleiben vorgemerkt
    expect(second.bot.core.global().get('loadedCogs')).toEqual(['merk', 'fehltjetzt']);
  });

  it('Kern-Cog kann nicht entladen werden', async () => {
    const { bot: b } = await bot();
    await expect(b.cogs.unload('core')).rejects.toMatchObject({ key: 'cogs.errors.internal' });
  });

  it('die mitgelieferten Cogs (example, permissions, downloader) laden fehlerfrei', async () => {
    const { bot: b } = await bot({ withBuiltinCogs: true });
    for (const name of ['example', 'permissions', 'downloader']) await b.cogs.load(name);
    expect(b.registry.get('hello')?.cogName).toBe('example');
    expect(b.registry.find('perms addserverrule')?.cogName).toBe('permissions');
    expect(b.registry.find('repo add')?.cogName).toBe('downloader');
  });

  it('core-Befehle load/unload/cogs funktionieren über Nachrichten', async () => {
    const { bot: b, cogsDir, rest, platform } = await bot();
    seedGuild(platform);
    writeCog(cogsDir, 'delta', simpleCog('d'));
    await b.dispatcher.handleMessage(makeMessage('!load delta', IDS.botOwner));
    expect(b.cogs.isLoaded('delta')).toBe(true);
    await b.dispatcher.handleMessage(makeMessage('!load delta', IDS.user));
    expect(rest.sentTexts().at(-1)).toContain('Bot-Owner');
    await b.dispatcher.handleMessage(makeMessage('!cogs', IDS.botOwner));
    const cogsMsg = rest.calls.at(-1)!.options!.body as { embeds: Array<{ fields: Array<{ name: string; value: string }> }> };
    expect(cogsMsg.embeds[0]!.fields[0]!.name).toBe('2 geladen:');
    expect(cogsMsg.embeds[0]!.fields[0]!.value).toContain('core, delta');
    await b.dispatcher.handleMessage(makeMessage('!unload delta', IDS.botOwner));
    expect(b.cogs.isLoaded('delta')).toBe(false);
    expect(b.core.global().get('loadedCogs')).toEqual([]);
  });
});
