import fs from 'node:fs';
import path from 'node:path';
import { defineCog, embed, fetchText, OptionType, pagify, UserError, type APIMessage, type Cog, type CommandContext } from '@bot/sdk';
import type { EconomyApi } from '../economy/index.js';

export interface Question {
  question: string;
  answers: string[];
}
export interface TriviaList {
  name: string;
  description?: string;
  author?: string;
  questions: Question[];
}

/** Antworten vergleichbar machen: klein, ohne Satzzeichen, Umlaute vereinheitlicht. */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Richtig, wenn die Nachricht der Antwort entspricht oder – bei Antworten ab 4 Zeichen –
 * die Antwort als ganze Wortfolge enthält ("Ich glaube Goethe" zählt für "Goethe").
 */
export function isCorrect(guess: string, answers: string[]): boolean {
  const g = normalize(guess);
  if (!g) return false;
  return answers.some((a) => {
    const n = normalize(a);
    if (!n) return false;
    if (g === n) return true;
    return n.length >= 4 && ` ${g} `.includes(` ${n} `);
  });
}

export function validateList(data: unknown): TriviaList {
  const l = data as TriviaList;
  if (!l || typeof l !== 'object' || !Array.isArray(l.questions)) throw new Error('questions fehlt');
  const questions = l.questions.filter((q) => typeof q?.question === 'string' && Array.isArray(q.answers) && q.answers.length > 0).map((q) => ({ question: q.question, answers: q.answers.map(String) }));
  if (!questions.length) throw new Error('keine gültigen Fragen');
  return { name: String(l.name ?? 'Eigene Liste'), description: l.description, author: l.author, questions };
}

interface Session {
  channelId: string;
  guildId: string;
  starter: string;
  lists: string[];
  scores: Map<string, number>;
  stopped: boolean;
  /** Wartet auf die richtige Antwort der aktuellen Frage. */
  waiter: ((m: APIMessage) => void) | null;
  /** Bricht das Warten auf die aktuelle Frage ab (bei stop). */
  cancel: (() => void) | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default defineCog({
  setup(cog: Cog) {
    cog.config.registerGuild({ maxScore: 10, timeout: 20, delay: 3, revealAnswer: true, payout: 0, unansweredStop: 3 });
    cog.config.registerMember({ games: 0, wins: 0, points: 0 });
    const builtinDir = path.join(cog.dir, 'lists');
    const customDir = path.join(cog.bot.env.dataDir, 'trivia');
    const sessions = new Map<string, Session>();

    const listFiles = (): Map<string, string> => {
      const out = new Map<string, string>();
      for (const dir of [builtinDir, customDir]) {
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir)) if (f.endsWith('.json')) out.set(path.basename(f, '.json').toLowerCase(), path.join(dir, f));
      }
      return out;
    };
    const loadList = (name: string): TriviaList => {
      const file = listFiles().get(name.toLowerCase());
      if (!file) throw new UserError(cog.t('unknownList', { name }));
      return validateList(JSON.parse(fs.readFileSync(file, 'utf8')));
    };

    cog.on('MESSAGE_CREATE', (m: APIMessage) => {
      const s = sessions.get(m.channel_id);
      if (!s?.waiter || !m.author || (m.author as { bot?: boolean }).bot) return;
      s.waiter(m);
    });

    async function run(s: Session, questions: Question[]): Promise<void> {
      const conf = cog.config.guild(s.guildId);
      const t = (key: string, vars?: Record<string, string | number>) => cog.tg(s.guildId, key, vars);
      const maxScore = conf.get<number>('maxScore');
      let unanswered = 0;
      let n = 0;
      for (const q of questions) {
        if (s.stopped) break;
        n++;
        await cog.bot.send(s.channelId, { content: `**${t('question', { n })}** ${q.question}` });
        const winner = await new Promise<APIMessage | null>((resolve) => {
          const timer = setTimeout(() => {
            s.waiter = null;
            resolve(null);
          }, conf.get<number>('timeout') * 1000);
          s.waiter = (m) => {
            if (!isCorrect(m.content ?? '', q.answers)) return;
            clearTimeout(timer);
            s.waiter = null;
            resolve(m);
          };
          s.cancel = () => {
            clearTimeout(timer);
            s.waiter = null;
            resolve(null);
          };
        });
        if (s.stopped) break;
        if (winner) {
          unanswered = 0;
          const points = (s.scores.get(winner.author.id) ?? 0) + 1;
          s.scores.set(winner.author.id, points);
          await cog.bot.send(s.channelId, { content: t('correct', { user: `<@${winner.author.id}>`, answer: q.answers[0]!, points }), allowed_mentions: { parse: [] } });
          if (points >= maxScore) break;
        } else {
          unanswered++;
          await cog.bot.send(s.channelId, { content: conf.get<boolean>('revealAnswer') ? t('timeoutReveal', { answer: q.answers[0]! }) : t('timeout') });
          if (unanswered >= conf.get<number>('unansweredStop')) {
            await cog.bot.send(s.channelId, { content: t('tooQuiet') });
            break;
          }
        }
        await sleep(conf.get<number>('delay') * 1000);
      }
      await finish(s);
    }

    async function finish(s: Session): Promise<void> {
      sessions.delete(s.channelId);
      const ranking = [...s.scores.entries()].sort((a, b) => b[1] - a[1]);
      for (const [userId, points] of ranking) {
        cog.config.member(s.guildId, userId).update<number>('games', (g) => g + 1);
        cog.config.member(s.guildId, userId).update<number>('points', (p) => p + points);
      }
      if (!ranking.length) {
        await cog.bot.send(s.channelId, { content: cog.tg(s.guildId, 'noPoints') });
        return;
      }
      const [winnerId, best] = ranking[0]!;
      const tie = ranking.filter(([, p]) => p === best).length > 1;
      if (!tie) cog.config.member(s.guildId, winnerId).update<number>('wins', (w) => w + 1);
      let payoutText = '';
      const multiplier = cog.config.guild(s.guildId).get<number>('payout');
      const eco = cog.bot.cogApi<EconomyApi>('economy');
      // Wie bei Red: Belohnung nur bei mindestens 3 Teilnehmenden und eindeutigem Sieg
      if (!tie && multiplier > 0 && eco && ranking.length >= 3) {
        const amount = Math.round(best * multiplier);
        eco.deposit(s.guildId, winnerId, amount);
        payoutText = `\n${cog.tg(s.guildId, 'payout', { user: `<@${winnerId}>`, amount: eco.format(s.guildId, amount) })}`;
      }
      const medals = ['🥇', '🥈', '🥉'];
      const lines = ranking.slice(0, 10).map(([u, p], i) => `${medals[i] ?? `${i + 1}.`} <@${u}> – ${p}`);
      const e = embed({ title: cog.tg(s.guildId, 'resultTitle'), description: `${lines.join('\n')}${payoutText}`, color: 0xf1c40f });
      await cog.bot.send(s.channelId, await cog.bot.adaptPayload({ embeds: [e], allowed_mentions: { parse: [] } }, s.guildId, s.channelId));
    }

    cog.group({
      name: 'trivia',
      description: 'Quiz starten: trivia <liste> [weitere Listen …]',
      aliases: ['quiz'],
      guildOnly: true,
      options: [{ name: 'listen', description: 'Eine oder mehrere Fragenlisten (siehe trivia list)', type: OptionType.String, required: true, variadic: true }],
      examples: ['trivia allgemeinwissen', 'trivia geografie wissenschaft'],
      run: async (ctx) => {
        if (sessions.has(ctx.channelId)) throw new UserError(ctx.t('alreadyRunning'));
        const names = [...new Set(ctx.arg<string[]>('listen').map((n) => n.toLowerCase()))];
        const questions: Question[] = [];
        for (const name of names) questions.push(...loadList(name).questions);
        for (let i = questions.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [questions[i], questions[j]] = [questions[j]!, questions[i]!];
        }
        const s: Session = { channelId: ctx.channelId, guildId: ctx.guildId!, starter: ctx.author.id, lists: names, scores: new Map(), stopped: false, waiter: null, cancel: null };
        sessions.set(ctx.channelId, s);
        const conf = cog.config.guild(ctx.guildId!);
        await ctx.send(ctx.t('starting', { lists: names.join(', '), count: questions.length, max: conf.get<number>('maxScore'), timeout: conf.get<number>('timeout') }));
        void run(s, questions).catch((err) => {
          cog.log.error({ err }, 'Trivia-Runde abgebrochen');
          sessions.delete(ctx.channelId);
        });
      },
      subcommands: [
        {
          name: 'stop',
          description: 'Beendet das laufende Quiz (Starter oder Mods).',
          run: async (ctx) => {
            const s = sessions.get(ctx.channelId);
            if (!s) throw new UserError(ctx.t('notRunning'));
            const isMod = ['mod', 'admin', 'guildowner', 'owner'].includes(await ctx.bot.levelOf(ctx.guildId, ctx.author.id));
            if (s.starter !== ctx.author.id && !isMod) throw new UserError(ctx.t('notStarter'));
            s.stopped = true;
            s.cancel?.();
            await ctx.reply(ctx.t('stopped'));
          },
        },
        {
          name: 'list',
          description: 'Verfügbare Fragenlisten.',
          run: async (ctx) => {
            const lines = [...listFiles().entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, file]) => {
              try {
                const l = validateList(JSON.parse(fs.readFileSync(file, 'utf8')));
                return `\`${key}\` – ${l.name} (${l.questions.length})`;
              } catch {
                return `\`${key}\` – ⚠️ ${ctx.t('broken')}`;
              }
            });
            await ctx.sendEmbed({ title: ctx.t('listsTitle'), description: lines.join('\n') || '–' });
          },
        },
        {
          name: 'leaderboard',
          description: 'Bestenliste (Siege, Punkte, Spiele).',
          aliases: ['top'],
          options: [
            {
              name: 'nach',
              description: 'wins, points oder games',
              type: OptionType.String,
              default: 'wins',
              choices: [
                { name: 'siege', value: 'wins' },
                { name: 'punkte', value: 'points' },
                { name: 'spiele', value: 'games' },
              ],
            },
          ],
          run: async (ctx) => {
            const key = ctx.arg<'wins' | 'points' | 'games'>('nach');
            const rows = Object.entries(cog.config.allMembers<{ wins: number; points: number; games: number }>(ctx.guildId!)[ctx.guildId!] ?? {})
              .filter(([, d]) => d.games > 0)
              .sort(([, a], [, b]) => b[key] - a[key]);
            if (!rows.length) return ctx.reply(ctx.t('noStats'));
            const lines = rows.map(([u, d], i) => `**${i + 1}.** <@${u}> – ${d.wins} ${ctx.t('wins')}, ${d.points} ${ctx.t('points')}, ${d.games} ${ctx.t('games')}`);
            await ctx.paginate(pagify(lines.join('\n'), { pageLength: 1500 }).map((pg) => embed({ title: ctx.t('boardTitle'), description: pg })));
          },
        },
      ],
    });

    const admin = { level: 'admin', member: ['ManageGuild'] } as const;
    const numSet = (name: string, key: string, description: string, min: number, max: number) => ({
      name,
      description,
      options: [{ name: 'wert', description: 'Wert', type: OptionType.Integer, required: true, min_value: min, max_value: max }],
      run: async (ctx: CommandContext) => {
        cog.config.guild(ctx.guildId!).set(key, ctx.arg<number>('wert'));
        await ctx.tick();
      },
    });

    cog.group({
      name: 'triviaset',
      description: 'Trivia-Einstellungen.',
      guildOnly: true,
      permissions: admin,
      run: async (ctx) => {
        const c = cog.config.guild(ctx.guildId!).all() as Record<string, number | boolean>;
        await ctx.sendEmbed({
          title: ctx.t('settingsTitle'),
          description: ctx.t('settingsBody', { max: c.maxScore as number, timeout: c.timeout as number, delay: c.delay as number, reveal: c.revealAnswer ? '✅' : '❌', payout: c.payout as number, stop: c.unansweredStop as number }),
        });
      },
      subcommands: [
        numSet('maxscore', 'maxScore', 'Punkte zum Sieg.', 1, 100),
        numSet('timeout', 'timeout', 'Sekunden pro Frage.', 5, 300),
        numSet('delay', 'delay', 'Pause zwischen Fragen (Sekunden).', 0, 60),
        numSet('payout', 'payout', 'Belohnung je Punkt für den Sieg (0 = aus, braucht economy).', 0, 100000),
        numSet('stopafter', 'unansweredStop', 'Nach so vielen unbeantworteten Fragen stoppen.', 1, 50),
        {
          name: 'reveal',
          description: 'Antwort zeigen, wenn niemand sie weiß.',
          options: [{ name: 'aktiv', description: 'an/aus', type: OptionType.Boolean, required: true }],
          run: async (ctx: CommandContext) => {
            cog.config.guild(ctx.guildId!).set('revealAnswer', ctx.arg<boolean>('aktiv'));
            await ctx.tick();
          },
        },
        {
          name: 'upload',
          description: 'Eigene Fragenliste als JSON-Anhang hochladen (gilt für alle Server).',
          permissions: { level: 'owner' },
          options: [
            { name: 'name', description: 'Kurzname der Liste', type: OptionType.String, required: true },
            { name: 'datei', description: 'JSON-Datei', type: OptionType.Attachment, required: true },
          ],
          run: async (ctx: CommandContext) => {
            const name = ctx.arg<string>('name').toLowerCase();
            if (!/^[a-z0-9_-]{1,32}$/.test(name)) throw new UserError(ctx.t('badName'));
            const file = ctx.arg<{ url: string }>('datei');
            let list: TriviaList;
            try {
              list = validateList(JSON.parse(await fetchText(file.url, { timeoutMs: 20_000 })));
            } catch (err) {
              throw new UserError(ctx.t('badFile', { reason: (err as Error).message }));
            }
            fs.mkdirSync(customDir, { recursive: true });
            fs.writeFileSync(path.join(customDir, `${name}.json`), JSON.stringify(list, null, 2));
            await ctx.reply(ctx.t('uploaded', { name, count: list.questions.length }));
          },
        },
        {
          name: 'delete',
          description: 'Eigene Fragenliste löschen.',
          permissions: { level: 'owner' },
          options: [{ name: 'name', description: 'Kurzname', type: OptionType.String, required: true }],
          run: async (ctx: CommandContext) => {
            const file = path.join(customDir, `${ctx.arg<string>('name').toLowerCase()}.json`);
            if (!fs.existsSync(file)) throw new UserError(ctx.t('onlyCustom'));
            fs.rmSync(file);
            await ctx.tick();
          },
        },
      ],
    });

    cog.onUnload(() => {
      for (const s of sessions.values()) {
        s.stopped = true;
        s.cancel?.();
      }
    });
  },
});
