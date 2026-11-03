import { defineCog, fetchJson, OptionType, UserError, type Cog, type CommandContext } from '@bot/sdk';

interface ImgurItem {
  title: string | null;
  link: string;
  is_album?: boolean;
  images?: Array<{ link: string; type: string }>;
  nsfw?: boolean;
  type?: string;
}

/** Erstes anzeigbares Bild aus einem Imgur-Ergebnis (Alben → erstes Bild). */
export function imgurImage(item: ImgurItem): string | undefined {
  if (item.is_album) return item.images?.find((i) => i.type.startsWith('image/'))?.link;
  return item.type?.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(item.link) ? item.link : undefined;
}

export default defineCog({
  setup(cog: Cog) {
    const env = process.env;
    const pick = <T>(arr: T[]): T | undefined => arr[Math.floor(Math.random() * arr.length)];
    const showImage = (ctx: CommandContext, title: string, url: string, source: string) =>
      ctx.sendEmbed({ title: title.slice(0, 200), url, image: url, footer: source, color: 0x2ecc71 }).then(() => undefined);

    cog.command({
      name: 'imgur',
      description: 'Sucht ein Bild auf Imgur (braucht IMGUR_CLIENT_ID).',
      aliases: ['image'],
      cooldown: { rate: 3, per: 20, bucket: 'user' },
      options: [{ name: 'suche', description: 'Suchbegriff', type: OptionType.String, required: true, rest: true }],
      run: async (ctx) => {
        if (!env.IMGUR_CLIENT_ID) throw new UserError(ctx.t('noImgurKey'));
        await ctx.typing();
        const res = await fetchJson<{ data: ImgurItem[] }>(`https://api.imgur.com/3/gallery/search/top?q=${encodeURIComponent(ctx.arg<string>('suche'))}`, {
          headers: { Authorization: `Client-ID ${env.IMGUR_CLIENT_ID}` },
          signal: cog.signal,
        }).catch(() => {
          throw new UserError(ctx.t('apiDown', { api: 'Imgur' }));
        });
        const channel = ctx.guildId ? ctx.bot.platform.getChannel(ctx.channelId) : undefined;
        const allowNsfw = Boolean((channel as { nsfw?: boolean } | undefined)?.nsfw);
        const items = res.data.filter((i) => (allowNsfw || !i.nsfw) && imgurImage(i));
        const item = pick(items.slice(0, 20));
        if (!item) throw new UserError(ctx.t('nothing'));
        await showImage(ctx, item.title ?? ctx.arg<string>('suche'), imgurImage(item)!, 'Imgur');
      },
    });

    cog.command({
      name: 'gif',
      description: 'Sucht ein GIF auf GIPHY (braucht GIPHY_API_KEY).',
      cooldown: { rate: 3, per: 20, bucket: 'user' },
      options: [{ name: 'suche', description: 'Suchbegriff', type: OptionType.String, required: true, rest: true }],
      run: async (ctx) => {
        if (!env.GIPHY_API_KEY) throw new UserError(ctx.t('noGiphyKey'));
        await ctx.typing();
        const q = new URLSearchParams({ api_key: env.GIPHY_API_KEY, q: ctx.arg<string>('suche'), limit: '20', rating: 'pg-13', lang: 'de' });
        const res = await fetchJson<{ data: Array<{ title: string; url: string; images: { original: { url: string } } }> }>(`https://api.giphy.com/v1/gifs/search?${q}`, { signal: cog.signal }).catch(() => {
          throw new UserError(ctx.t('apiDown', { api: 'GIPHY' }));
        });
        const gif = pick(res.data);
        if (!gif) throw new UserError(ctx.t('nothing'));
        await showImage(ctx, gif.title || ctx.arg<string>('suche'), gif.images.original.url, 'Powered by GIPHY');
      },
    });

    const animal = (name: string, aliases: string[], description: string, load: () => Promise<string>, source: string) =>
      cog.command({
        name,
        description,
        aliases,
        cooldown: { rate: 5, per: 20, bucket: 'user' },
        run: async (ctx) => {
          const url = await load().catch(() => {
            throw new UserError(ctx.t('apiDown', { api: source }));
          });
          await showImage(ctx, ctx.t(`animals.${name}`), url, source);
        },
      });

    animal('cat', ['katze'], 'Zufälliges Katzenbild.', async () => (await fetchJson<Array<{ url: string }>>('https://api.thecatapi.com/v1/images/search', { signal: cog.signal }))[0]!.url, 'TheCatAPI');
    animal('dog', ['hund'], 'Zufälliges Hundebild.', async () => (await fetchJson<{ message: string }>('https://dog.ceo/api/breeds/image/random', { signal: cog.signal })).message, 'dog.ceo');
    animal('fox', ['fuchs'], 'Zufälliges Fuchsbild.', async () => (await fetchJson<{ image: string }>('https://randomfox.ca/floof/', { signal: cog.signal })).image, 'randomfox.ca');

  },
});
