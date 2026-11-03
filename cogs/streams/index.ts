import { defineCog, embed, fetchJson, fetchText, OptionType, UserError, type APIEmbed, type Cog, type CommandContext } from '@bot/sdk';

type Platform = 'twitch' | 'youtube';

interface Alert {
  platform: Platform;
  /** Twitch-Login bzw. YouTube-Kanal-ID (UC…). */
  id: string;
  name: string;
  channelId: string;
}

interface State {
  live: boolean;
  streamId: string | null;
  lastVideoId: string | null;
  checkedAt: number;
}

export interface FeedEntry {
  videoId: string;
  title: string;
  url: string;
  published: string;
  author: string;
}

/** YouTube-RSS (Atom) ohne XML-Bibliothek auslesen. */
export function parseYoutubeFeed(xml: string): FeedEntry[] {
  const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const author = decode(/<author>\s*<name>([^<]*)<\/name>/.exec(xml)?.[1] ?? '');
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => {
    const e = m[1]!;
    const videoId = /<yt:videoId>([^<]+)<\/yt:videoId>/.exec(e)?.[1] ?? '';
    return {
      videoId,
      title: decode(/<title>([^<]*)<\/title>/.exec(e)?.[1] ?? ''),
      url: /<link rel="alternate" href="([^"]+)"/.exec(e)?.[1] ?? `https://www.youtube.com/watch?v=${videoId}`,
      published: /<published>([^<]+)<\/published>/.exec(e)?.[1] ?? '',
      author,
    };
  });
}

/** Eingabe → YouTube-Kanal-ID, falls direkt erkennbar. */
export function youtubeChannelIdFrom(input: string): string | undefined {
  return /(UC[\w-]{22})/.exec(input)?.[1];
}

export default defineCog({
  setup(cog: Cog) {
    cog.config.registerGuild({
      alerts: [] as Alert[],
      mention: null as string | null,
      message: '🔴 **{name}** ist jetzt live!',
      videoMessage: '📺 **{name}** hat ein neues Video hochgeladen!',
    });
    cog.config.registerCustom('state', { live: false, streamId: null, lastVideoId: null, checkedAt: 0 });
    const env = process.env;
    let twitchToken: { token: string; expires: number } | null = null;

    // ------------------------------------------------------------------ Twitch
    async function twitchAuth(): Promise<string> {
      const id = env.TWITCH_CLIENT_ID;
      const secret = env.TWITCH_CLIENT_SECRET;
      if (!id || !secret) throw new UserError(cog.t('twitchNoKey'));
      if (twitchToken && twitchToken.expires > Date.now() + 60_000) return twitchToken.token;
      const res = await fetchJson<{ access_token: string; expires_in: number }>('https://id.twitch.tv/oauth2/token', {
        body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: 'client_credentials' }),
        signal: cog.signal,
      });
      twitchToken = { token: res.access_token, expires: Date.now() + res.expires_in * 1000 };
      return twitchToken.token;
    }
    async function twitch<T>(path: string): Promise<T> {
      const token = await twitchAuth();
      return fetchJson<T>(`https://api.twitch.tv/helix/${path}`, { headers: { 'Client-Id': env.TWITCH_CLIENT_ID!, Authorization: `Bearer ${token}` }, signal: cog.signal });
    }

    // ------------------------------------------------------------------ YouTube
    async function resolveYoutube(input: string): Promise<{ id: string; name: string }> {
      let id = youtubeChannelIdFrom(input);
      if (!id) {
        // @handle oder Kanal-URL: Kanalseite laden und ID auslesen (Annahme: YouTube liefert "channelId" im HTML)
        const handle = input.startsWith('http') ? input : `https://www.youtube.com/${input.startsWith('@') ? input : `@${input}`}`;
        const html = await fetchText(handle, { signal: cog.signal, headers: { 'accept-language': 'de-DE' } }).catch(() => '');
        id = /"(?:channelId|externalId)":"(UC[\w-]{22})"/.exec(html)?.[1];
      }
      if (!id) throw new UserError(cog.t('ytNotFound'));
      const feed = parseYoutubeFeed(await fetchText(`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`, { signal: cog.signal }).catch(() => ''));
      return { id, name: feed[0]?.author || id };
    }

    // ------------------------------------------------------------------ Benachrichtigen
    async function notify(platform: Platform, id: string, text: (g: string) => string, e: APIEmbed): Promise<void> {
      for (const [guildId, data] of Object.entries(cog.config.allGuilds<{ alerts: Alert[]; mention: string | null }>())) {
        for (const a of data.alerts ?? []) {
          if (a.platform !== platform || a.id !== id) continue;
          const mention = data.mention === 'everyone' ? '@everyone ' : data.mention ? `<@&${data.mention}> ` : '';
          const allowed = data.mention === 'everyone' ? { parse: ['everyone' as const] } : data.mention ? { roles: [data.mention] } : { parse: [] };
          await cog.bot
            .send(a.channelId, { ...(await cog.bot.adaptPayload({ embeds: [e] }, guildId, a.channelId)), content: `${mention}${text(guildId)}`, allowed_mentions: allowed }, guildId)
            .catch((err) => cog.log.warn({ err, guildId }, 'Stream-Benachrichtigung fehlgeschlagen'));
        }
      }
    }

    const allAlerts = (): Alert[] => Object.values(cog.config.allGuilds<{ alerts: Alert[] }>()).flatMap((d) => d.alerts ?? []);
    const fill = (tpl: string, v: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (m, k: string) => v[k] ?? m);

    async function checkTwitch(): Promise<void> {
      if (!env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET) return;
      const logins = [...new Set(allAlerts().filter((a) => a.platform === 'twitch').map((a) => a.id))];
      for (let i = 0; i < logins.length; i += 100) {
        const chunk = logins.slice(i, i + 100);
        const res = await twitch<{ data: Array<{ id: string; user_login: string; user_name: string; title: string; game_name: string; thumbnail_url: string; viewer_count: number }> }>(
          `streams?${chunk.map((l) => `user_login=${encodeURIComponent(l)}`).join('&')}`,
        );
        const live = new Map(res.data.map((s) => [s.user_login.toLowerCase(), s]));
        for (const login of chunk) {
          const state = cog.config.custom('state', 'twitch', login);
          const s = live.get(login);
          if (s && (!state.get<boolean>('live') || state.get<string | null>('streamId') !== s.id)) {
            state.setAll({ live: true, streamId: s.id, checkedAt: Date.now() });
            const url = `https://twitch.tv/${login}`;
            const e = embed({
              title: s.title || s.user_name,
              url,
              author: s.user_name,
              fields: [
                { name: cog.t('game'), value: s.game_name || '–', inline: true },
                { name: cog.t('viewers'), value: String(s.viewer_count), inline: true },
              ],
              image: s.thumbnail_url.replace('{width}', '1280').replace('{height}', '720') + `?t=${Date.now()}`,
              color: 0x9146ff,
            });
            await notify('twitch', login, (g) => fill(cog.config.guild(g).get<string>('message'), { name: s.user_name, title: s.title, url, game: s.game_name }), e);
          } else if (!s && state.get<boolean>('live')) {
            state.setAll({ live: false, checkedAt: Date.now() });
          }
        }
      }
    }

    async function checkYoutube(): Promise<void> {
      const ids = [...new Set(allAlerts().filter((a) => a.platform === 'youtube').map((a) => a.id))];
      for (const id of ids) {
        const entries = parseYoutubeFeed(await fetchText(`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`, { signal: cog.signal }).catch(() => ''));
        if (!entries.length) continue;
        const state = cog.config.custom('state', 'youtube', id);
        const last = state.get<string | null>('lastVideoId');
        const newest = entries[0]!;
        if (!last) {
          // Erster Durchlauf: nur merken, nicht alte Videos melden
          state.set('lastVideoId', newest.videoId);
          continue;
        }
        if (newest.videoId === last) continue;
        const idx = entries.findIndex((e) => e.videoId === last);
        const fresh = (idx === -1 ? entries.slice(0, 1) : entries.slice(0, idx)).reverse();
        state.set('lastVideoId', newest.videoId);
        for (const v of fresh) {
          const e = embed({ title: v.title, url: v.url, author: v.author, image: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`, color: 0xff0000 });
          await notify('youtube', id, (g) => fill(cog.config.guild(g).get<string>('videoMessage'), { name: v.author, title: v.title, url: v.url }) + `\n${v.url}`, e);
        }
      }
      // Optional: YouTube-Livestreams (kostet API-Kontingent: 100 Einheiten pro Abfrage)
      const key = env.YOUTUBE_API_KEY;
      if (!key) return;
      for (const id of ids) {
        const res = await fetchJson<{ items: Array<{ id: { videoId: string }; snippet: { title: string; channelTitle: string } }> }>(
          `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${id}&eventType=live&type=video&key=${encodeURIComponent(key)}`,
          { signal: cog.signal },
        ).catch(() => undefined);
        if (!res) continue;
        const state = cog.config.custom('state', 'youtube', id);
        const liveItem = res.items[0];
        if (liveItem && state.get<string | null>('streamId') !== liveItem.id.videoId) {
          state.setAll({ live: true, streamId: liveItem.id.videoId });
          const url = `https://www.youtube.com/watch?v=${liveItem.id.videoId}`;
          const e = embed({ title: liveItem.snippet.title, url, author: liveItem.snippet.channelTitle, image: `https://i.ytimg.com/vi/${liveItem.id.videoId}/hqdefault_live.jpg`, color: 0xff0000 });
          await notify('youtube', id, (g) => fill(cog.config.guild(g).get<string>('message'), { name: liveItem.snippet.channelTitle, title: liveItem.snippet.title, url }), e);
        } else if (!liveItem && state.get<boolean>('live')) {
          state.set('live', false);
        }
      }
    }

    cog.schedule({ name: 'twitch-check', every: 120, run: () => checkTwitch() });
    cog.schedule({ name: 'youtube-check', every: env.YOUTUBE_API_KEY ? 900 : 300, run: () => checkYoutube() });

    // ------------------------------------------------------------------ Befehle
    const channelOpt = { name: 'kanal', description: 'Kanal für Benachrichtigungen (Standard: dieser)', type: OptionType.Channel, channel_types: [0, 5] } as const;
    const addAlert = (ctx: CommandContext, a: Alert) => {
      cog.config.guild(ctx.guildId!).update<Alert[]>('alerts', (list) => [...list.filter((x) => !(x.platform === a.platform && x.id === a.id && x.channelId === a.channelId)), a]);
    };

    cog.group({
      name: 'streamalert',
      description: 'Stream- und Video-Benachrichtigungen.',
      aliases: ['streams'],
      guildOnly: true,
      permissions: { level: 'mod', member: ['ManageGuild'] },
      subcommands: [
        {
          name: 'twitch',
          description: 'Twitch-Kanal beobachten (braucht TWITCH_CLIENT_ID/SECRET).',
          options: [{ name: 'login', description: 'Twitch-Name', type: OptionType.String, required: true }, channelOpt],
          run: async (ctx) => {
            const login = ctx.arg<string>('login').toLowerCase().replace(/^https?:\/\/(www\.)?twitch\.tv\//, '').replace(/\/.*$/, '');
            const res = await twitch<{ data: Array<{ login: string; display_name: string }> }>(`users?login=${encodeURIComponent(login)}`);
            const user = res.data[0];
            if (!user) throw new UserError(ctx.t('twitchNotFound'));
            addAlert(ctx, { platform: 'twitch', id: user.login, name: user.display_name, channelId: ctx.arg<{ id: string } | undefined>('kanal')?.id ?? ctx.channelId });
            await ctx.reply(ctx.t('added', { name: user.display_name, platform: 'Twitch' }));
          },
        },
        {
          name: 'youtube',
          description: 'YouTube-Kanal beobachten (neue Videos; Livestreams nur mit YOUTUBE_API_KEY).',
          options: [{ name: 'kanal_id', description: 'Kanal-ID (UC…), @Handle oder Kanal-URL', type: OptionType.String, required: true }, channelOpt],
          run: async (ctx) => {
            await ctx.typing();
            const yt = await resolveYoutube(ctx.arg<string>('kanal_id'));
            addAlert(ctx, { platform: 'youtube', id: yt.id, name: yt.name, channelId: ctx.arg<{ id: string } | undefined>('kanal')?.id ?? ctx.channelId });
            await ctx.reply(ctx.t('added', { name: yt.name, platform: 'YouTube' }));
          },
        },
        {
          name: 'remove',
          description: 'Beobachtung entfernen.',
          options: [{ name: 'name', description: 'Name oder ID', type: OptionType.String, required: true }],
          run: async (ctx) => {
            const needle = ctx.arg<string>('name').toLowerCase();
            let removed = 0;
            cog.config.guild(ctx.guildId!).update<Alert[]>('alerts', (list) => {
              const keep = list.filter((a) => a.id.toLowerCase() !== needle && a.name.toLowerCase() !== needle);
              removed = list.length - keep.length;
              return keep;
            });
            if (!removed) throw new UserError(ctx.t('notFound'));
            await ctx.tick();
          },
        },
        {
          name: 'list',
          description: 'Alle Beobachtungen.',
          permissions: { level: 'everyone' },
          run: async (ctx) => {
            const list = cog.config.guild(ctx.guildId!).get<Alert[]>('alerts');
            await ctx.sendEmbed({
              title: ctx.t('listTitle'),
              description: list.map((a) => `${a.platform === 'twitch' ? '🟣' : '🔴'} **${a.name}** (\`${a.id}\`) → <#${a.channelId}>`).join('\n') || ctx.t('none'),
            });
          },
        },
      ],
    });

    cog.group({
      name: 'streamset',
      description: 'Einstellungen für Stream-Benachrichtigungen.',
      guildOnly: true,
      permissions: { level: 'admin', member: ['ManageGuild'] },
      subcommands: [
        {
          name: 'mention',
          description: 'Wen erwähnen: @rolle, "everyone" oder "aus".',
          options: [{ name: 'ziel', description: '@rolle, everyone oder aus', type: OptionType.String, required: true }],
          run: async (ctx) => {
            const raw = ctx.arg<string>('ziel').toLowerCase();
            const role = /^<@&(\d+)>$/.exec(raw)?.[1] ?? (ctx.guild?.roles.has(raw) ? raw : undefined);
            const value = raw === 'everyone' || raw === '@everyone' ? 'everyone' : ['aus', 'off', 'keine'].includes(raw) ? null : role;
            if (value === undefined) throw new UserError(ctx.t('badMention'));
            cog.config.guild(ctx.guildId!).set('mention', value);
            await ctx.tick();
          },
        },
        {
          name: 'message',
          description: 'Text bei Livestreams ({name}, {title}, {url}, {game}).',
          options: [{ name: 'text', description: 'Text', type: OptionType.String, required: true, rest: true, max_length: 500 }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('message', ctx.arg<string>('text'));
            await ctx.tick();
          },
        },
        {
          name: 'videomessage',
          description: 'Text bei neuen YouTube-Videos ({name}, {title}, {url}).',
          options: [{ name: 'text', description: 'Text', type: OptionType.String, required: true, rest: true, max_length: 500 }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('videoMessage', ctx.arg<string>('text'));
            await ctx.tick();
          },
        },
        {
          name: 'check',
          description: 'Jetzt prüfen (Owner).',
          permissions: { level: 'owner' },
          run: async (ctx) => {
            await ctx.typing();
            await checkTwitch();
            await checkYoutube();
            await ctx.tick();
          },
        },
      ],
    });

  },
});
