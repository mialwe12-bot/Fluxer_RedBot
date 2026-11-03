import { defineCog, OptionType, UserError, type Cog, type CommandContext } from '@bot/sdk';
import type { EconomyApi } from '../economy/index.js';

export const SIZE = 5;
export const CENTER = 12;
export const LETTERS = ['B', 'I', 'N', 'G', 'O'];

interface Card {
  gameId: number;
  tiles: string[];
  marked: number[];
}

/** Zufällige Karte: 24 Felder + freies Feld in der Mitte (vorab markiert). */
export function makeCard(tiles: string[], free: string, rnd: () => number = Math.random): string[] {
  const pool = [...tiles];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  const picked = pool.slice(0, SIZE * SIZE - 1);
  picked.splice(CENTER, 0, free);
  return picked;
}

/** Alle vollständigen Reihen (Zeilen, Spalten, Diagonalen) als Index-Listen. */
export function completedLines(marked: Set<number>): number[][] {
  const lines: number[][] = [];
  for (let r = 0; r < SIZE; r++) lines.push([...Array(SIZE).keys()].map((c) => r * SIZE + c));
  for (let c = 0; c < SIZE; c++) lines.push([...Array(SIZE).keys()].map((r) => r * SIZE + c));
  lines.push([0, 6, 12, 18, 24], [4, 8, 12, 16, 20]);
  return lines.filter((l) => l.every((i) => marked.has(i)));
}

/** "B3" (Spalte B, Zeile 3), "13" (Feld 1–25) oder Teil des Feldtextes → Index. */
export function resolveCell(input: string, tiles: string[]): number | undefined {
  const t = input.trim();
  const coord = /^([bingo])\s*([1-5])$/i.exec(t);
  if (coord) return (Number(coord[2]) - 1) * SIZE + LETTERS.indexOf(coord[1]!.toUpperCase());
  if (/^\d{1,2}$/.test(t)) {
    const n = Number(t);
    return n >= 1 && n <= 25 ? n - 1 : undefined;
  }
  const lower = t.toLowerCase();
  const exact = tiles.findIndex((x) => x.toLowerCase() === lower);
  if (exact >= 0) return exact;
  const hits = tiles.map((x, i) => [x, i] as const).filter(([x]) => x.toLowerCase().includes(lower));
  return hits.length === 1 ? hits[0]![1] : undefined;
}

export function renderCard(card: Card, title: string): string {
  const marked = new Set(card.marked);
  const grid = [...Array(SIZE).keys()]
    .map((r) => [...Array(SIZE).keys()].map((c) => (r * SIZE + c === CENTER ? '⭐' : marked.has(r * SIZE + c) ? '✅' : '⬜')).join(''))
    .join('\n');
  const legend = card.tiles
    .map((tile, i) => `${marked.has(i) || i === CENTER ? '~~' : ''}\`${LETTERS[i % SIZE]}${Math.floor(i / SIZE) + 1}\` ${tile}${marked.has(i) || i === CENTER ? '~~' : ''}`)
    .join('\n');
  return `**${title}**\n🅱️🇮🇳🇬🅾️\n${grid}\n\n${legend}`;
}

export default defineCog({
  setup(cog: Cog) {
    cog.config.registerGuild({ name: 'Bingo', tiles: [] as string[], free: 'Freies Feld', reward: 0, gameId: 1, winners: [] as string[] });
    cog.config.registerCustom('card', { gameId: 0, tiles: [] as string[], marked: [] as number[] });
    const conf = (g: string) => cog.config.guild(g);

    const cardFor = (ctx: CommandContext, create = true): Card => {
      const c = conf(ctx.guildId!);
      const gameId = c.get<number>('gameId');
      const stored = cog.config.custom('card', ctx.guildId!, ctx.author.id).all() as unknown as Card;
      if (stored.gameId === gameId && stored.tiles.length === SIZE * SIZE) return stored;
      if (!create) throw new UserError(ctx.t('noCard', { prefix: ctx.prefix }));
      const tiles = c.get<string[]>('tiles');
      if (tiles.length < SIZE * SIZE - 1) throw new UserError(ctx.t('notEnoughTiles', { count: tiles.length }));
      const card: Card = { gameId, tiles: makeCard(tiles, c.get<string>('free')), marked: [CENTER] };
      cog.config.custom('card', ctx.guildId!, ctx.author.id).setAll(card as unknown as Record<string, unknown>);
      return card;
    };

    const toggleMark = async (ctx: CommandContext, mark: boolean) => {
      const card = cardFor(ctx);
      const idx = resolveCell(ctx.arg<string>('feld'), card.tiles);
      if (idx === undefined) throw new UserError(ctx.t('unknownCell'));
      if (idx === CENTER) throw new UserError(ctx.t('centerFree'));
      const marked = new Set(card.marked);
      if (mark) marked.add(idx);
      else marked.delete(idx);
      const updated = { ...card, marked: [...marked].sort((a, b) => a - b) };
      cog.config.custom('card', ctx.guildId!, ctx.author.id).setAll(updated as unknown as Record<string, unknown>);
      const lines = completedLines(marked);
      const winners = conf(ctx.guildId!).get<string[]>('winners');
      if (mark && lines.length && !winners.includes(ctx.author.id)) {
        conf(ctx.guildId!).set('winners', [...winners, ctx.author.id]);
        let rewardText = '';
        const reward = conf(ctx.guildId!).get<number>('reward');
        const eco = ctx.bot.cogApi<EconomyApi>('economy');
        if (reward > 0 && eco) {
          eco.deposit(ctx.guildId!, ctx.author.id, reward);
          rewardText = ` ${ctx.t('reward', { amount: eco.format(ctx.guildId!, reward) })}`;
        }
        await ctx.send({ content: ctx.t('bingo', { user: `<@${ctx.author.id}>`, place: winners.length + 1 }) + rewardText, allowed_mentions: { parse: [] } });
      }
      await ctx.reply(renderCard(updated, conf(ctx.guildId!).get<string>('name')));
    };

    cog.group({
      name: 'bingo',
      description: 'Zeigt deine Bingo-Karte (wird beim ersten Mal erstellt).',
      guildOnly: true,
      run: async (ctx) => {
        await ctx.reply(renderCard(cardFor(ctx), conf(ctx.guildId!).get<string>('name')));
      },
      subcommands: [
        {
          name: 'mark',
          description: 'Feld markieren (z. B. B3, 13 oder Text).',
          aliases: ['x', 'markieren'],
          options: [{ name: 'feld', description: 'B3, 1–25 oder Teil des Textes', type: OptionType.String, required: true, rest: true }],
          run: (ctx) => toggleMark(ctx, true),
        },
        {
          name: 'unmark',
          description: 'Markierung entfernen.',
          options: [{ name: 'feld', description: 'B3, 1–25 oder Teil des Textes', type: OptionType.String, required: true, rest: true }],
          run: (ctx) => toggleMark(ctx, false),
        },
        {
          name: 'winners',
          description: 'Wer hat in dieser Runde schon Bingo?',
          run: async (ctx) => {
            const w = conf(ctx.guildId!).get<string[]>('winners');
            await ctx.reply(w.length ? w.map((u, i) => `${i + 1}. <@${u}>`).join('\n') : ctx.t('noWinners'));
          },
        },
        {
          name: 'new',
          description: 'Neue Runde: alle Karten werden neu gemischt.',
          permissions: { level: 'mod', member: ['ManageGuild'] },
          run: async (ctx) => {
            conf(ctx.guildId!).update<number>('gameId', (n) => n + 1);
            conf(ctx.guildId!).set('winners', []);
            await ctx.reply(ctx.t('newGame', { prefix: ctx.prefix }));
          },
        },
      ],
    });

    cog.group({
      name: 'bingoset',
      description: 'Bingo einrichten.',
      guildOnly: true,
      permissions: { level: 'admin', member: ['ManageGuild'] },
      run: async (ctx) => {
        const tiles = conf(ctx.guildId!).get<string[]>('tiles');
        await ctx.sendEmbed({
          title: ctx.t('settingsTitle', { name: conf(ctx.guildId!).get<string>('name') }),
          description: tiles.map((t, i) => `${i + 1}. ${t}`).join('\n').slice(0, 3800) || '–',
          footer: ctx.t('settingsFooter', { count: tiles.length, free: conf(ctx.guildId!).get<string>('free'), reward: conf(ctx.guildId!).get<number>('reward') }),
        });
      },
      subcommands: [
        {
          name: 'tiles',
          description: 'Alle Felder setzen, getrennt mit ; (mindestens 24).',
          options: [{ name: 'felder', description: 'Feld 1; Feld 2; …', type: OptionType.String, required: true, rest: true }],
          run: async (ctx) => {
            const tiles = [...new Set(ctx.arg<string>('felder').split(';').map((t) => t.trim()).filter(Boolean))].map((t) => t.slice(0, 80));
            conf(ctx.guildId!).set('tiles', tiles);
            await ctx.reply(ctx.t(tiles.length >= 24 ? 'tilesSet' : 'tilesSetFew', { count: tiles.length }));
          },
        },
        {
          name: 'add',
          description: 'Ein Feld hinzufügen.',
          options: [{ name: 'feld', description: 'Text', type: OptionType.String, required: true, rest: true, max_length: 80 }],
          run: async (ctx) => {
            conf(ctx.guildId!).update<string[]>('tiles', (l) => [...new Set([...l, ctx.arg<string>('feld').trim()])]);
            await ctx.tick();
          },
        },
        {
          name: 'remove',
          description: 'Ein Feld entfernen (Nummer aus der Liste).',
          options: [{ name: 'nummer', description: 'Nummer', type: OptionType.Integer, required: true, min_value: 1 }],
          run: async (ctx) => {
            conf(ctx.guildId!).update<string[]>('tiles', (l) => l.filter((_, i) => i !== ctx.arg<number>('nummer') - 1));
            await ctx.tick();
          },
        },
        {
          name: 'free',
          description: 'Text des freien Mittelfelds.',
          options: [{ name: 'text', description: 'Text', type: OptionType.String, required: true, rest: true, max_length: 80 }],
          run: async (ctx) => {
            conf(ctx.guildId!).set('free', ctx.arg<string>('text'));
            await ctx.tick();
          },
        },
        {
          name: 'name',
          description: 'Name des Bingos.',
          options: [{ name: 'name', description: 'Name', type: OptionType.String, required: true, rest: true, max_length: 60 }],
          run: async (ctx) => {
            conf(ctx.guildId!).set('name', ctx.arg<string>('name'));
            await ctx.tick();
          },
        },
        {
          name: 'reward',
          description: 'Belohnung für ein Bingo (0 = keine, braucht economy).',
          options: [{ name: 'betrag', description: 'Betrag', type: OptionType.Integer, required: true, min_value: 0 }],
          run: async (ctx) => {
            conf(ctx.guildId!).set('reward', ctx.arg<number>('betrag'));
            await ctx.tick();
          },
        },
      ],
    });
  },
});
