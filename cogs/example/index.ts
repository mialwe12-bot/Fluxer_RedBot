import { defineCog, embed, NUMBER_EMOJIS, OptionType, type ResolvedUser } from '@bot/sdk';

/**
 * Beispiel-Cog – Vorlage für eigene Cogs.
 * Zeigt: einfache Befehle, Befehlsgruppe, Optionen, Cooldown, Config (guild/member),
 * Reaktions-Pagination, Ja/Nein-Abfrage, Auswahl per Zahlen-Reaktion, Event-Listener und Task.
 */
export default defineCog({
  setup(cog) {
    // 1) Config-Defaults im eigenen Namensraum "example"
    cog.config.registerGuild({ greeting: null as string | null });
    cog.config.registerMember({ hellos: 0 });
    cog.config.registerGlobal({ totalHellos: 0 });

    // 2) Einfacher Befehl mit optionalem Benutzer-Argument und Cooldown
    cog.command({
      name: 'hello',
      description: cog.t('hello.description'),
      aliases: ['hallo', 'hi'],
      options: [{ name: 'user', description: cog.t('hello.userOption'), type: OptionType.User }],
      cooldown: { rate: 3, per: 30, bucket: 'user' },
      examples: ['hello', 'hello @Anna'],
      run: async (ctx) => {
        const target = ctx.arg<ResolvedUser | undefined>('user');
        const name = target ? `<@${target.id}>` : `<@${ctx.author.id}>`;
        const custom = ctx.guildId ? cog.config.guild(ctx.guildId).get<string | null>('greeting') : null;
        const text = custom ? custom.replace('{user}', name) : ctx.t('hello.reply', { user: name });
        if (ctx.guildId) cog.config.member(ctx.guildId, ctx.author.id).update<number>('hellos', (n) => n + 1);
        cog.config.global().update<number>('totalHellos', (n) => n + 1);
        await ctx.reply(text);
      },
    });

    // 3) Befehl mit Rest-Argument
    cog.command({
      name: 'echo',
      description: cog.t('echo.description'),
      options: [{ name: 'text', description: cog.t('echo.textOption'), type: OptionType.String, required: true, rest: true, max_length: 1500 }],
      permissions: { level: 'mod', member: ['ManageMessages'] },
      guildOnly: true,
      run: async (ctx) => {
        await ctx.send({ content: ctx.arg<string>('text'), allowed_mentions: { parse: [] } });
      },
    });

    // 4) Gruppe mit Unterbefehlen
    cog.group({
      name: 'beispiel',
      description: cog.t('group.description'),
      aliases: ['example'],
      subcommands: [
        {
          name: 'zaehler',
          description: cog.t('counter.description'),
          aliases: ['counter'],
          guildOnly: true,
          run: async (ctx) => {
            const mine = cog.config.member(ctx.guildId!, ctx.author.id).get<number>('hellos');
            const total = cog.config.global().get<number>('totalHellos');
            await ctx.reply(ctx.t('counter.reply', { count: mine, total }));
          },
        },
        {
          name: 'gruss',
          description: cog.t('greeting.description'),
          aliases: ['greeting'],
          guildOnly: true,
          permissions: { level: 'admin', member: ['ManageGuild'] },
          options: [{ name: 'text', description: cog.t('greeting.textOption'), type: OptionType.String, rest: true, max_length: 300 }],
          run: async (ctx) => {
            const text = ctx.arg<string | undefined>('text');
            const conf = cog.config.guild(ctx.guildId!);
            if (!text || text.toLowerCase() === 'reset') {
              conf.clear('greeting');
              return ctx.reply(ctx.t('greeting.reset'));
            }
            conf.set('greeting', text);
            await ctx.reply(ctx.t('greeting.set', { text }));
          },
        },
        {
          name: 'seiten',
          description: cog.t('pages.description'),
          aliases: ['pages'],
          run: async (ctx) => {
            const pages = [1, 2, 3, 4, 5].map((n) =>
              embed({ title: ctx.t('pages.title', { n }), description: ctx.t('pages.body', { n }), footer: `${n}/5` }),
            );
            await ctx.paginate(pages);
          },
        },
        {
          name: 'frage',
          description: cog.t('confirm.description'),
          aliases: ['confirm'],
          run: async (ctx) => {
            const answer = await ctx.confirm(ctx.t('confirm.question'));
            const key = answer === null ? 'confirm.timeout' : answer ? 'confirm.yes' : 'confirm.no';
            await ctx.reply(ctx.t(key));
          },
        },
        {
          name: 'wahl',
          description: cog.t('choose.description'),
          aliases: ['choose'],
          run: async (ctx) => {
            const fruits = ['🍎 Apfel', '🍌 Banane', '🍒 Kirsche', '🍇 Traube', '🍉 Melone'];
            const list = fruits.map((f, i) => `${NUMBER_EMOJIS[i]} ${f}`).join('\n');
            const index = await ctx.choose(embed({ title: ctx.t('choose.title'), description: list }), fruits.length);
            await ctx.reply(index === null ? ctx.t('choose.none') : ctx.t('choose.picked', { choice: fruits[index]! }));
          },
        },
      ],
    });

    // 5) Event-Listener (Gateway-Event)
    cog.on('GUILD_MEMBER_ADD', (member: { guild_id: string; user: { username: string } }) => {
      cog.log.debug({ guild: member.guild_id, user: member.user.username }, 'Neues Mitglied');
    });

    // 6) Geplanter Task (Bot-Zeitzone, Standard Europe/Berlin): jeden Tag um 09:00
    cog.schedule({
      name: 'guten-morgen-log',
      cron: '0 9 * * *',
      run: () => cog.log.info({ hellos: cog.config.global().get('totalHellos') }, 'Guten Morgen aus dem Beispiel-Cog'),
    });

    cog.onReady(() => cog.log.debug('Beispiel-Cog bereit'));
  },

  teardown(cog) {
    cog.log.debug('Beispiel-Cog wird entladen');
  },
});
