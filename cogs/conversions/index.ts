import { defineCog, fetchJson, OptionType, UserError, type Cog } from '@bot/sdk';

/** Einheiten je Kategorie: Faktor zur Basiseinheit. */
const UNITS: Record<string, Record<string, number>> = {
  length: { mm: 0.001, cm: 0.01, dm: 0.1, m: 1, km: 1000, in: 0.0254, zoll: 0.0254, ft: 0.3048, fuß: 0.3048, fuss: 0.3048, yd: 0.9144, mi: 1609.344, meile: 1609.344, meilen: 1609.344, sm: 1852, nmi: 1852 },
  mass: { mg: 1e-6, g: 0.001, kg: 1, t: 1000, tonne: 1000, oz: 0.028349523125, unze: 0.028349523125, lb: 0.45359237, lbs: 0.45359237, pfund: 0.5, st: 6.35029318 },
  volume: { ml: 0.001, cl: 0.01, dl: 0.1, l: 1, liter: 1, m3: 1000, gal: 3.785411784, gallon: 3.785411784, qt: 0.946352946, pt: 0.473176473, floz: 0.0295735295625, tasse: 0.25, el: 0.015, tl: 0.005 },
  speed: { 'm/s': 1, ms: 1, 'km/h': 1 / 3.6, kmh: 1 / 3.6, mph: 0.44704, kn: 0.514444, knoten: 0.514444 },
  data: { b: 1, bit: 0.125, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 },
  time: { ms: 0.001, s: 1, sek: 1, min: 60, h: 3600, std: 3600, d: 86400, tag: 86400, tage: 86400, woche: 604800, wochen: 604800, jahr: 31557600, jahre: 31557600 },
  area: { 'mm²': 1e-6, mm2: 1e-6, 'cm²': 1e-4, cm2: 1e-4, 'm²': 1, m2: 1, qm: 1, a: 100, ar: 100, ha: 1e4, 'km²': 1e6, km2: 1e6, acre: 4046.8564224, 'ft²': 0.09290304, ft2: 0.09290304 },
};
const TEMPS = ['c', '°c', 'celsius', 'f', '°f', 'fahrenheit', 'k', 'kelvin'];

function tempToC(v: number, u: string): number {
  if (u.includes('f')) return ((v - 32) * 5) / 9;
  if (u.startsWith('k')) return v - 273.15;
  return v;
}
function cToTemp(c: number, u: string): number {
  if (u.includes('f')) return (c * 9) / 5 + 32;
  if (u.startsWith('k')) return c + 273.15;
  return c;
}

/** Physikalische Einheiten umrechnen. undefined = keine passende Kategorie. */
export function convertUnit(value: number, from: string, to: string): number | undefined {
  const f = from.toLowerCase();
  const t = to.toLowerCase();
  if (TEMPS.includes(f) && TEMPS.includes(t)) return cToTemp(tempToC(value, f), t);
  for (const table of Object.values(UNITS)) {
    if (f in table && t in table) return (value * table[f]!) / table[t]!;
  }
  return undefined;
}

export function formatValue(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const abs = Math.abs(n);
  const digits = abs === 0 ? 0 : abs >= 1000 ? 2 : abs >= 1 ? 4 : 6;
  return new Intl.NumberFormat('de-DE', { maximumFractionDigits: digits }).format(n);
}

/** Häufige Krypto-Kürzel → CoinGecko-IDs. */
const COINS: Record<string, string> = {
  btc: 'bitcoin', bitcoin: 'bitcoin', eth: 'ethereum', ethereum: 'ethereum', sol: 'solana', xrp: 'ripple', ada: 'cardano',
  doge: 'dogecoin', ltc: 'litecoin', dot: 'polkadot', bnb: 'binancecoin', usdt: 'tether', usdc: 'usd-coin', xmr: 'monero', trx: 'tron', link: 'chainlink',
};

export default defineCog({
  setup(cog: Cog) {
    const rateCache = new Map<string, { at: number; rates: Record<string, number> }>();

    async function currencyRate(from: string, to: string): Promise<number | undefined> {
      const key = from.toUpperCase();
      let entry = rateCache.get(key);
      if (!entry || Date.now() - entry.at > 3600_000) {
        const data = await fetchJson<{ rates: Record<string, number> }>(`https://api.frankfurter.app/latest?from=${encodeURIComponent(key)}`, { signal: cog.signal }).catch(() => undefined);
        if (!data) return undefined;
        entry = { at: Date.now(), rates: { ...data.rates, [key]: 1 } };
        rateCache.set(key, entry);
      }
      return entry.rates[to.toUpperCase()];
    }

    async function coinPrice(coin: string, vs: string): Promise<{ id: string; price: number } | undefined> {
      let id = COINS[coin.toLowerCase()];
      if (!id) {
        const search = await fetchJson<{ coins: Array<{ id: string; symbol: string; name: string }> }>(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(coin)}`, { signal: cog.signal }).catch(() => undefined);
        id = search?.coins.find((c) => c.symbol.toLowerCase() === coin.toLowerCase() || c.name.toLowerCase() === coin.toLowerCase())?.id ?? search?.coins[0]?.id;
      }
      if (!id) return undefined;
      const data = await fetchJson<Record<string, Record<string, number>>>(
        `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=${encodeURIComponent(vs.toLowerCase())}`,
        { signal: cog.signal },
      ).catch(() => undefined);
      const price = data?.[id]?.[vs.toLowerCase()];
      return price === undefined ? undefined : { id, price };
    }

    cog.command({
      name: 'convert',
      description: 'Rechnet Einheiten, Währungen oder Kryptowährungen um.',
      aliases: ['umrechnen', 'conv'],
      cooldown: { rate: 5, per: 30, bucket: 'user' },
      options: [
        { name: 'menge', description: 'Zahl', type: OptionType.Number, required: true },
        { name: 'von', description: 'Einheit/Währung, z. B. km, °F, EUR, BTC', type: OptionType.String, required: true },
        { name: 'nach', description: 'Zieleinheit (optional "in" davor)', type: OptionType.String, required: true, rest: true },
      ],
      examples: ['convert 5 km mi', 'convert 100 °F in °C', 'convert 20 EUR USD', 'convert 0.5 BTC EUR'],
      run: async (ctx) => {
        const value = ctx.arg<number>('menge');
        const from = ctx.arg<string>('von');
        const to = ctx.arg<string>('nach').replace(/^(in|nach|to)\s+/i, '').trim();
        const unit = convertUnit(value, from, to);
        if (unit !== undefined) return ctx.reply(`📐 ${formatValue(value)} ${from} = **${formatValue(unit)} ${to}**`);
        if (/^[a-z]{3}$/i.test(from) && /^[a-z]{3}$/i.test(to)) {
          await ctx.typing();
          const rate = await currencyRate(from, to);
          if (rate !== undefined) return ctx.reply(`💱 ${formatValue(value)} ${from.toUpperCase()} = **${formatValue(value * rate)} ${to.toUpperCase()}** ${ctx.t('ecbNote')}`);
          const coin = await coinPrice(from, to);
          if (coin) return ctx.reply(`🪙 ${formatValue(value)} ${from.toUpperCase()} = **${formatValue(value * coin.price)} ${to.toUpperCase()}** ${ctx.t('geckoNote')}`);
        }
        throw new UserError(ctx.t('unknown'));
      },
    });

    cog.command({
      name: 'crypto',
      description: 'Aktueller Kurs einer Kryptowährung.',
      aliases: ['krypto'],
      cooldown: { rate: 3, per: 30, bucket: 'user' },
      options: [
        { name: 'coin', description: 'z. B. BTC, ETH, solana', type: OptionType.String, required: true },
        { name: 'waehrung', description: 'z. B. EUR (Standard), USD', type: OptionType.String, default: 'EUR' },
      ],
      run: async (ctx) => {
        await ctx.typing();
        const coin = await coinPrice(ctx.arg<string>('coin'), ctx.arg<string>('waehrung'));
        if (!coin) throw new UserError(ctx.t('noCoin'));
        await ctx.reply(`🪙 1 ${ctx.arg<string>('coin').toUpperCase()} (${coin.id}) = **${formatValue(coin.price)} ${ctx.arg<string>('waehrung').toUpperCase()}** ${ctx.t('geckoNote')}`);
      },
    });

    cog.command({
      name: 'units',
      description: 'Liste der unterstützten Einheiten.',
      aliases: ['einheiten'],
      run: async (ctx) => {
        const lines = Object.entries(UNITS).map(([cat, table]) => `**${ctx.t(`cat.${cat}`)}:** ${Object.keys(table).join(', ')}`);
        lines.push(`**${ctx.t('cat.temp')}:** °C, °F, K`, `**${ctx.t('cat.currency')}:** ${ctx.t('currencyHint')}`);
        await ctx.sendEmbed({ title: ctx.t('unitsTitle'), description: lines.join('\n') });
      },
    });
  },
});
