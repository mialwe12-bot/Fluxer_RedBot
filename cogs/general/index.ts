import {
  defineCog,
  embed,
  fetchJson,
  formatDateTime,
  formatNumber,
  humanizeSeconds,
  OptionType,
  UserError,
  type Cog,
  type ResolvedUser,
} from '@bot/sdk';

export const EIGHT_BALL = [
  'Es ist sicher.',
  'Ganz bestimmt.',
  'Ohne Zweifel.',
  'Ja – definitiv.',
  'Darauf kannst du dich verlassen.',
  'So wie ich es sehe: ja.',
  'Höchstwahrscheinlich.',
  'Sieht gut aus.',
  'Ja.',
  'Die Zeichen deuten auf ja.',
  'Antwort unklar, versuch es noch mal.',
  'Frag später noch einmal.',
  'Das sage ich dir jetzt besser nicht.',
  'Kann ich gerade nicht vorhersagen.',
  'Konzentrier dich und frag noch mal.',
  'Verlass dich nicht darauf.',
  'Meine Antwort ist nein.',
  'Meine Quellen sagen nein.',
  'Sieht nicht so gut aus.',
  'Sehr zweifelhaft.',
];

export type Rps = 'stein' | 'papier' | 'schere';
export function rpsWinner(a: Rps, b: Rps): 0 | 1 | 2 {
  if (a === b) return 0;
  return (a === 'stein' && b === 'schere') || (a === 'schere' && b === 'papier') || (a === 'papier' && b === 'stein') ? 1 : 2;
}

/** Text auf dem Kopf (für "flip @user", wie bei Red). */
export function upsideDown(text: string): string {
  const map: Record<string, string> = {
    a: 'ɐ', b: 'q', c: 'ɔ', d: 'p', e: 'ǝ', f: 'ɟ', g: 'ƃ', h: 'ɥ', i: 'ᴉ', j: 'ɾ', k: 'ʞ', l: 'l', m: 'ɯ', n: 'u', o: 'o',
    p: 'd', q: 'b', r: 'ɹ', s: 's', t: 'ʇ', u: 'n', v: 'ʌ', w: 'ʍ', x: 'x', y: 'ʎ', z: 'z', ä: 'ɐ̤', ö: 'o̤', ü: 'n̤',
  };
  return [...text.toLowerCase()].reverse().map((c) => map[c] ?? c).join('');
}

export default defineCog({
  setup(cog: Cog) {
    const stopwatches = new Map<string, number>();
    const rand = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]!;

    cog.command({
      name: '8ball',
      description: 'Stell der magischen Kugel eine Ja/Nein-Frage.',
      options: [{ name: 'frage', description: 'Deine Frage (mit ?)', type: OptionType.String, required: true, rest: true }],
      run: async (ctx) => {
        if (!ctx.arg<string>('frage').trim().endsWith('?')) throw new UserError(ctx.t('notAQuestion'));
        await ctx.reply(`🎱 ${rand(EIGHT_BALL)}`);
      },
    });

    cog.command({
      name: 'choose',
      description: 'Wählt eine von mehreren Möglichkeiten (mit Leerzeichen oder Anführungszeichen getrennt).',
      aliases: ['wähle', 'waehle'],
      options: [{ name: 'optionen', description: 'Mindestens zwei Optionen', type: OptionType.String, required: true, variadic: true }],
      run: async (ctx) => {
        const opts = ctx.arg<string[]>('optionen').filter((o) => o.trim());
        if (opts.length < 2) throw new UserError(ctx.t('chooseMore'));
        await ctx.reply(ctx.t('chosen', { choice: rand(opts) }));
      },
    });

    cog.command({
      name: 'flip',
      description: 'Wirft eine Münze – oder dreht jemanden auf den Kopf.',
      aliases: ['münze', 'muenze'],
      options: [{ name: 'user', description: 'Wen umdrehen?', type: OptionType.User }],
      run: async (ctx) => {
        const user = ctx.arg<ResolvedUser | undefined>('user');
        if (user) {
          const name = user.member?.nick ?? user.user?.username ?? 'jemand';
          const target = user.id === ctx.bot.platform.user?.id ? ctx.author.username : name;
          return ctx.reply(`(╯°□°）╯︵ ${upsideDown(target)}`);
        }
        await ctx.reply(Math.random() < 0.5 ? ctx.t('heads') : ctx.t('tails'));
      },
    });

    cog.command({
      name: 'roll',
      description: 'Würfelt eine Zahl von 1 bis N (Standard 100).',
      aliases: ['würfeln', 'wuerfeln'],
      options: [{ name: 'max', description: 'Höchste Zahl', type: OptionType.Integer, min_value: 2, max_value: 1_000_000_000, default: 100 }],
      run: async (ctx) => {
        const n = 1 + Math.floor(Math.random() * ctx.arg<number>('max'));
        await ctx.reply(ctx.t('rolled', { user: `<@${ctx.author.id}>`, number: formatNumber(n) }));
      },
    });

    cog.command({
      name: 'rps',
      description: 'Schere, Stein, Papier gegen den Bot.',
      aliases: ['ssp'],
      options: [
        {
          name: 'wahl',
          description: 'stein, papier oder schere',
          type: OptionType.String,
          required: true,
          choices: [
            { name: 'stein', value: 'stein' },
            { name: 'papier', value: 'papier' },
            { name: 'schere', value: 'schere' },
          ],
        },
      ],
      run: async (ctx) => {
        const emojis: Record<Rps, string> = { stein: '🪨', papier: '📄', schere: '✂️' };
        const you = ctx.arg<Rps>('wahl');
        const bot = rand<Rps>(['stein', 'papier', 'schere']);
        const result = rpsWinner(you, bot);
        await ctx.reply(`${emojis[you]} vs ${emojis[bot]} – ${ctx.t(result === 0 ? 'rpsDraw' : result === 1 ? 'rpsWin' : 'rpsLose')}`);
      },
    });

    cog.command({
      name: 'lmgtfy',
      description: 'Erstellt einen „Lass mich das für dich googeln“-Link.',
      options: [{ name: 'suche', description: 'Suchbegriff', type: OptionType.String, required: true, rest: true }],
      run: async (ctx) => {
        await ctx.send({ content: `<https://lmgtfy.app/?q=${encodeURIComponent(ctx.arg<string>('suche'))}>`, allowed_mentions: { parse: [] } });
      },
    });

    cog.command({
      name: 'stopwatch',
      description: 'Startet oder stoppt deine Stoppuhr.',
      aliases: ['stoppuhr'],
      run: async (ctx) => {
        const start = stopwatches.get(ctx.author.id);
        if (start === undefined) {
          stopwatches.set(ctx.author.id, Date.now());
          return ctx.reply(ctx.t('swStarted'));
        }
        stopwatches.delete(ctx.author.id);
        await ctx.reply(ctx.t('swStopped', { time: humanizeSeconds((Date.now() - start) / 1000) }));
      },
    });

    cog.command({
      name: 'serverinfo',
      description: 'Informationen über diesen Server.',
      aliases: ['server'],
      guildOnly: true,
      run: async (ctx) => {
        const g = ctx.guild!;
        const channels = [...g.channels.values()];
        const text = channels.filter((c) => [0, 5].includes(Number(c.type))).length;
        const voice = channels.filter((c) => Number(c.type) === 2).length;
        const inVoice = [...g.voiceStates.values()].filter((v) => v.channel_id).length;
        const online = [...g.presences.values()].filter((p) => p.status && p.status !== 'offline' && p.status !== 'invisible').length;
        // Erstellungsdatum aus der Snowflake ist auf Fluxer nicht verifiziert – daher nicht angezeigt.
        await ctx.sendEmbed(
          embed({
            title: g.name,
            fields: [
              { name: ctx.t('si.owner'), value: `<@${g.owner_id}>`, inline: true },
              { name: ctx.t('si.members'), value: `${formatNumber(g.member_count || g.members.size)}${online ? ` (${formatNumber(online)} online)` : ''}`, inline: true },
              { name: ctx.t('si.channels'), value: ctx.t('si.channelsValue', { text, voice }), inline: true },
              { name: ctx.t('si.roles'), value: String(Math.max(0, g.roles.size - 1)), inline: true },
              { name: ctx.t('si.inVoice'), value: String(inVoice), inline: true },
              { name: 'ID', value: `\`${g.id}\``, inline: true },
            ],
            footer: formatDateTime(new Date()),
          }),
        );
      },
    });

    cog.command({
      name: 'urban',
      description: 'Sucht einen Begriff im Urban Dictionary (englisch).',
      cooldown: { rate: 3, per: 30, bucket: 'user' },
      options: [{ name: 'begriff', description: 'Begriff', type: OptionType.String, required: true, rest: true }],
      run: async (ctx) => {
        await ctx.typing();
        const data = await fetchJson<{ list: Array<{ word: string; definition: string; example: string; permalink: string; thumbs_up: number; thumbs_down: number }> }>(
          `https://api.urbandictionary.com/v0/define?term=${encodeURIComponent(ctx.arg<string>('begriff'))}`,
          { signal: cog.signal },
        ).catch(() => {
          throw new UserError(ctx.t('urbanDown'));
        });
        if (!data.list?.length) throw new UserError(ctx.t('urbanNone'));
        const clean = (s: string) => s.replace(/\[([^\]]+)\]/g, '$1');
        await ctx.paginate(
          data.list.slice(0, 5).map((d) =>
            embed({
              title: d.word,
              url: d.permalink,
              description: clean(d.definition).slice(0, 2000),
              fields: d.example ? [{ name: ctx.t('example'), value: clean(d.example).slice(0, 1000) }] : [],
              footer: `👍 ${d.thumbs_up} · 👎 ${d.thumbs_down}`,
            }),
          ),
        );
      },
    });
  },
});
