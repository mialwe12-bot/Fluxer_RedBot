import {
  defineCog,
  embed,
  formatNumber,
  humanizeSeconds,
  OptionType,
  takeInteger,
  UserError,
  type Cog,
  type CommandContext,
  type ResolvedUser,
} from '@bot/sdk';

export const MAX_BALANCE = 2 ** 53 - 1;

/** Schnittstelle für andere Cogs (trivia, bingo, eventposter …). */
export interface EconomyApi {
  balance(guildId: string, userId: string): number;
  deposit(guildId: string, userId: string, amount: number): number;
  /** Wirft, wenn das Guthaben nicht reicht. */
  withdraw(guildId: string, userId: string, amount: number): number;
  canSpend(guildId: string, userId: string, amount: number): boolean;
  currency(guildId: string): string;
  format(guildId: string, amount: number): string;
}

export class InsufficientFunds extends Error {
  override name = 'InsufficientFunds';
}

/** Walzen des Spielautomaten und Auszahlungen (Multiplikator auf den Einsatz). */
export const REELS = ['🍒', '🍋', '🍊', '🍇', '🍀', '💎', '7️⃣'];
export function slotPayout(reels: string[]): { multiplier: number; key: string } {
  const [a, b, c] = reels;
  if (a === b && b === c) {
    if (a === '7️⃣') return { multiplier: 50, key: 'jackpot' };
    if (a === '💎') return { multiplier: 25, key: 'diamonds' };
    if (a === '🍀') return { multiplier: 15, key: 'clover' };
    return { multiplier: 10, key: 'three' };
  }
  if (reels.filter((r) => r === '🍒').length === 2) return { multiplier: 3, key: 'cherries' };
  if (a === b || b === c || a === c) return { multiplier: 2, key: 'two' };
  return { multiplier: 0, key: 'lose' };
}

interface Settings {
  bankName: string;
  currency: string;
  defaultBalance: number;
  paydayAmount: number;
  paydayCooldown: number;
  slotMin: number;
  slotMax: number;
  slotCooldown: number;
}

const DEFAULT_SETTINGS: Settings = {
  bankName: 'Bank',
  currency: 'Taler',
  defaultBalance: 0,
  paydayAmount: 120,
  paydayCooldown: 300,
  slotMin: 5,
  slotMax: 100,
  slotCooldown: 5,
};

export default defineCog({
  setup(cog: Cog) {
    const T = cog.tablePrefix + 'accounts';
    cog.migrate([
      `CREATE TABLE IF NOT EXISTS ${T} (scope TEXT NOT NULL, user_id TEXT NOT NULL, balance INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (scope, user_id))`,
      `CREATE INDEX IF NOT EXISTS ${T}_rank ON ${T} (scope, balance DESC)`,
    ]);
    cog.config.registerGlobal({ isGlobal: false, ...DEFAULT_SETTINGS });
    cog.config.registerGuild({ ...DEFAULT_SETTINGS });
    cog.config.registerCustom('cooldown', { payday: 0, slot: 0 });

    const db = cog.db;
    const q = {
      get: db.prepare(`SELECT balance FROM ${T} WHERE scope = ? AND user_id = ?`),
      set: db.prepare(
        `INSERT INTO ${T} (scope, user_id, balance, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (scope, user_id) DO UPDATE SET balance = excluded.balance, updated_at = excluded.updated_at`,
      ),
      top: db.prepare(`SELECT user_id, balance FROM ${T} WHERE scope = ? ORDER BY balance DESC LIMIT ? OFFSET ?`),
      rank: db.prepare(`SELECT COUNT(*) + 1 AS rank FROM ${T} WHERE scope = ? AND balance > ?`),
      reset: db.prepare(`DELETE FROM ${T} WHERE scope = ?`),
    };

    const isGlobal = () => cog.config.global().get<boolean>('isGlobal');
    const scopeOf = (guildId: string) => (isGlobal() ? 'global' : guildId);
    const settings = (guildId: string): Settings =>
      (isGlobal() ? cog.config.global().all() : cog.config.guild(guildId).all()) as unknown as Settings;
    const setSetting = (guildId: string, key: keyof Settings, value: unknown) =>
      isGlobal() ? cog.config.global().set(key, value) : cog.config.guild(guildId).set(key, value);

    const balance = (guildId: string, userId: string): number => {
      const row = q.get.get(scopeOf(guildId), userId) as { balance: number } | undefined;
      return row ? row.balance : settings(guildId).defaultBalance;
    };
    const setBalance = (guildId: string, userId: string, value: number): number => {
      const v = Math.max(0, Math.min(MAX_BALANCE, Math.floor(value)));
      q.set.run(scopeOf(guildId), userId, v, Date.now());
      return v;
    };
    const fmt = (guildId: string, n: number) => `${formatNumber(n)} ${settings(guildId).currency}`;

    const api: EconomyApi = {
      balance,
      deposit: (g, u, n) => db.transaction(() => setBalance(g, u, balance(g, u) + n))(),
      withdraw: (g, u, n) =>
        db.transaction(() => {
          const b = balance(g, u);
          if (b < n) throw new InsufficientFunds(cog.tg(g, 'insufficient', { balance: fmt(g, b) }));
          return setBalance(g, u, b - n);
        })(),
      canSpend: (g, u, n) => balance(g, u) >= n,
      currency: (g) => settings(g).currency,
      format: fmt,
    };
    cog.expose(api);

    const cooldownLeft = (guildId: string, userId: string, kind: 'payday' | 'slot', seconds: number): number => {
      const last = cog.config.custom('cooldown', scopeOf(guildId), userId).get<number>(kind);
      return Math.max(0, last + seconds * 1000 - Date.now()) / 1000;
    };
    const markCooldown = (guildId: string, userId: string, kind: 'payday' | 'slot') =>
      cog.config.custom('cooldown', scopeOf(guildId), userId).set(kind, Date.now());

    const amountOpt = { name: 'betrag', description: 'Betrag', type: OptionType.Integer, required: true, min_value: 1 } as const;

    cog.command({
      name: 'balance',
      description: 'Zeigt den Kontostand.',
      aliases: ['bal', 'kontostand'],
      guildOnly: true,
      options: [{ name: 'user', description: 'Benutzer (Standard: du)', type: OptionType.User }],
      run: async (ctx) => {
        const user = ctx.arg<ResolvedUser | undefined>('user') ?? { id: ctx.author.id };
        const b = balance(ctx.guildId!, user.id);
        const rank = (q.rank.get(scopeOf(ctx.guildId!), b) as { rank: number }).rank;
        await ctx.reply(ctx.t('balance', { user: `<@${user.id}>`, amount: fmt(ctx.guildId!, b), bank: settings(ctx.guildId!).bankName, rank }));
      },
    });

    cog.command({
      name: 'transfer',
      description: 'Überweist Geld an jemanden.',
      aliases: ['überweisen', 'pay'],
      guildOnly: true,
      options: [{ name: 'user', description: 'Empfänger', type: OptionType.User, required: true }, amountOpt],
      run: async (ctx) => {
        const to = ctx.arg<ResolvedUser>('user');
        const amount = ctx.arg<number>('betrag');
        if (to.id === ctx.author.id) throw new UserError(ctx.t('selfTransfer'));
        if ((to.user as { bot?: boolean } | undefined)?.bot) throw new UserError(ctx.t('botTransfer'));
        try {
          db.transaction(() => {
            api.withdraw(ctx.guildId!, ctx.author.id, amount);
            api.deposit(ctx.guildId!, to.id, amount);
          })();
        } catch (err) {
          if ((err as Error).name === 'InsufficientFunds') throw new UserError((err as Error).message);
          throw err;
        }
        await ctx.reply(ctx.t('transferred', { amount: fmt(ctx.guildId!, amount), user: `<@${to.id}>` }));
      },
    });

    cog.command({
      name: 'payday',
      description: 'Hol dir deinen Zahltag ab.',
      aliases: ['zahltag'],
      guildOnly: true,
      run: async (ctx) => {
        const s = settings(ctx.guildId!);
        const left = cooldownLeft(ctx.guildId!, ctx.author.id, 'payday', s.paydayCooldown);
        if (left > 0) throw new UserError(ctx.t('paydayWait', { time: humanizeSeconds(left) }));
        const now = api.deposit(ctx.guildId!, ctx.author.id, s.paydayAmount);
        markCooldown(ctx.guildId!, ctx.author.id, 'payday');
        await ctx.reply(ctx.t('payday', { amount: fmt(ctx.guildId!, s.paydayAmount), balance: fmt(ctx.guildId!, now) }));
      },
    });

    cog.command({
      name: 'slot',
      description: 'Spielautomat – setz einen Betrag.',
      guildOnly: true,
      options: [{ name: 'einsatz', description: 'Einsatz', type: OptionType.Integer, required: true, min_value: 1 }],
      run: async (ctx) => {
        const s = settings(ctx.guildId!);
        const bid = ctx.arg<number>('einsatz');
        if (bid < s.slotMin || bid > s.slotMax) throw new UserError(ctx.t('slotRange', { min: fmt(ctx.guildId!, s.slotMin), max: fmt(ctx.guildId!, s.slotMax) }));
        const left = cooldownLeft(ctx.guildId!, ctx.author.id, 'slot', s.slotCooldown);
        if (left > 0) throw new UserError(ctx.t('slotWait', { time: humanizeSeconds(left) }));
        if (!api.canSpend(ctx.guildId!, ctx.author.id, bid)) throw new UserError(ctx.t('insufficient', { balance: fmt(ctx.guildId!, balance(ctx.guildId!, ctx.author.id)) }));
        markCooldown(ctx.guildId!, ctx.author.id, 'slot');
        const reels = [0, 1, 2].map(() => REELS[Math.floor(Math.random() * REELS.length)]!);
        const { multiplier, key } = slotPayout(reels);
        const win = bid * multiplier;
        const after = db.transaction(() => {
          api.withdraw(ctx.guildId!, ctx.author.id, bid);
          return win ? api.deposit(ctx.guildId!, ctx.author.id, win) : balance(ctx.guildId!, ctx.author.id);
        })();
        await ctx.reply(
          `🎰 **[ ${reels.join(' | ')} ]**\n${ctx.t(`slots.${key}`)} ${win ? ctx.t('slotWin', { amount: fmt(ctx.guildId!, win) }) : ctx.t('slotLose', { amount: fmt(ctx.guildId!, bid) })}\n${ctx.t('newBalance', { balance: fmt(ctx.guildId!, after) })}`,
        );
      },
    });

    cog.command({
      name: 'leaderboard',
      description: 'Die reichsten Mitglieder.',
      aliases: ['richest', 'bestenliste'],
      guildOnly: true,
      options: [{ name: 'anzahl', description: 'Wie viele (Standard 10)', type: OptionType.Integer, min_value: 1, max_value: 100, default: 10 }],
      run: async (ctx) => {
        const n = ctx.arg<number>('anzahl');
        let rows = q.top.all(scopeOf(ctx.guildId!), isGlobal() ? n : n * 3, 0) as Array<{ user_id: string; balance: number }>;
        if (!isGlobal()) rows = rows.filter((r) => ctx.guild?.members.has(r.user_id) ?? true);
        rows = rows.slice(0, n);
        if (!rows.length) return ctx.reply(ctx.t('emptyBoard'));
        const medals = ['🥇', '🥈', '🥉'];
        const lines = rows.map((r, i) => `${medals[i] ?? `**${i + 1}.**`} <@${r.user_id}> – ${fmt(ctx.guildId!, r.balance)}`);
        await ctx.sendEmbed({ title: ctx.t('boardTitle', { bank: settings(ctx.guildId!).bankName }), description: lines.join('\n'), color: 0xf1c40f });
      },
    });

    // ------------------------------------------------------------------ Verwaltung
    const adminPerms = { level: 'admin', member: ['ManageGuild'] } as const;
    const numSetting = (name: string, key: keyof Settings, description: string, min = 0): Parameters<Cog['command']>[0] => ({
      name,
      description,
      options: [{ name: 'wert', description: 'Wert', type: OptionType.Integer, required: true, min_value: min }],
      run: async (ctx: CommandContext) => {
        setSetting(ctx.guildId!, key, ctx.arg<number>('wert'));
        await ctx.tick();
      },
    });

    cog.group({
      name: 'bank',
      description: 'Bank verwalten.',
      guildOnly: true,
      permissions: adminPerms,
      subcommands: [
        {
          name: 'set',
          description: 'Kontostand setzen (z. B. 500, +100, -50).',
          options: [
            { name: 'user', description: 'Benutzer', type: OptionType.User, required: true },
            { name: 'betrag', description: 'Betrag, +n oder -n', type: OptionType.String, required: true },
          ],
          run: async (ctx) => {
            const user = ctx.arg<ResolvedUser>('user');
            const raw = ctx.arg<string>('betrag').trim();
            const { value } = takeInteger(raw.replace(/^\+/, ''));
            if (value === undefined) throw new UserError(ctx.t('badAmount'));
            const current = balance(ctx.guildId!, user.id);
            const next = /^[+-]/.test(raw) ? current + value : value;
            const result = setBalance(ctx.guildId!, user.id, next);
            await ctx.reply(ctx.t('setDone', { user: `<@${user.id}>`, amount: fmt(ctx.guildId!, result) }));
          },
        },
        {
          name: 'reset',
          description: 'Alle Konten zurücksetzen.',
          permissions: { level: 'guildowner', member: ['Administrator'] },
          run: async (ctx) => {
            if (isGlobal() && !ctx.bot.isOwner(ctx.author.id)) throw new UserError(ctx.t('globalOwnerOnly'));
            if (!(await ctx.confirm(ctx.t('resetConfirm')))) return ctx.reply(ctx.t('common.cancelled'));
            q.reset.run(scopeOf(ctx.guildId!));
            await ctx.reply(ctx.t('resetDone'));
          },
        },
        {
          name: 'setglobal',
          description: 'Eine gemeinsame Bank für alle Server (an) oder je Server (aus).',
          permissions: { level: 'owner' },
          options: [{ name: 'global', description: 'an/aus', type: OptionType.Boolean, required: true }],
          run: async (ctx) => {
            cog.config.global().set('isGlobal', ctx.arg<boolean>('global'));
            await ctx.reply(ctx.t(ctx.arg<boolean>('global') ? 'nowGlobal' : 'nowLocal'));
          },
        },
      ],
    });

    cog.group({
      name: 'economyset',
      description: 'Einstellungen der Wirtschaft.',
      guildOnly: true,
      permissions: adminPerms,
      run: async (ctx) => {
        const s = settings(ctx.guildId!);
        await ctx.sendEmbed(
          embed({
            title: ctx.t('settingsTitle', { scope: isGlobal() ? ctx.t('scopeGlobal') : ctx.t('scopeServer') }),
            fields: [
              { name: ctx.t('settings.bankName'), value: s.bankName, inline: true },
              { name: ctx.t('settings.currency'), value: s.currency, inline: true },
              { name: ctx.t('settings.defaultBalance'), value: fmt(ctx.guildId!, s.defaultBalance), inline: true },
              { name: ctx.t('settings.payday'), value: `${fmt(ctx.guildId!, s.paydayAmount)} / ${humanizeSeconds(s.paydayCooldown)}`, inline: true },
              { name: ctx.t('settings.slot'), value: `${s.slotMin}–${s.slotMax} / ${s.slotCooldown}s`, inline: true },
            ],
          }),
        );
      },
      subcommands: [
        numSetting('paydayamount', 'paydayAmount', 'Betrag pro Zahltag.', 1),
        numSetting('paydaytime', 'paydayCooldown', 'Sekunden zwischen zwei Zahltagen.', 0),
        numSetting('slotmin', 'slotMin', 'Minimaler Einsatz am Automaten.', 1),
        numSetting('slotmax', 'slotMax', 'Maximaler Einsatz am Automaten.', 1),
        numSetting('slottime', 'slotCooldown', 'Sekunden zwischen zwei Spielen.', 0),
        numSetting('registeramount', 'defaultBalance', 'Startguthaben neuer Konten.', 0),
        {
          name: 'currency',
          description: 'Name der Währung.',
          options: [{ name: 'name', description: 'z. B. Taler', type: OptionType.String, required: true, rest: true, max_length: 32 }],
          run: async (ctx) => {
            setSetting(ctx.guildId!, 'currency', ctx.arg<string>('name'));
            await ctx.tick();
          },
        },
        {
          name: 'bankname',
          description: 'Name der Bank.',
          options: [{ name: 'name', description: 'z. B. Sparkasse', type: OptionType.String, required: true, rest: true, max_length: 64 }],
          run: async (ctx) => {
            setSetting(ctx.guildId!, 'bankName', ctx.arg<string>('name'));
            await ctx.tick();
          },
        },
      ],
    });
  },
});
