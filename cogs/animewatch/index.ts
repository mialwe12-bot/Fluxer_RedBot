import {
  defineCog,
  embed,
  fetchJson,
  formatDateTime,
  NUMBER_EMOJIS,
  OptionType,
  pagify,
  relativeTime,
  UserError,
  type Cog,
  type CommandContext,
  type ResolvedUser,
} from '@bot/sdk';

export type MediaType = 'anime' | 'tv' | 'movie';
export type Status = 'watching' | 'completed' | 'planned' | 'paused' | 'dropped';
export const STATUSES: Record<string, Status> = {
  schaue: 'watching', watching: 'watching', 'am-schauen': 'watching',
  fertig: 'completed', abgeschlossen: 'completed', completed: 'completed',
  geplant: 'planned', planned: 'planned',
  pausiert: 'paused', paused: 'paused',
  abgebrochen: 'dropped', dropped: 'dropped',
};

export interface SearchHit {
  source: 'anilist' | 'tmdb';
  type: MediaType;
  id: string;
  title: string;
  year: number | null;
  total: number | null;
  image: string | null;
}

interface Entry {
  id: number;
  user_id: string;
  source: 'anilist' | 'tmdb';
  media_type: MediaType;
  ext_id: string;
  title: string;
  status: Status;
  episode: number;
  season: number;
  rating: number | null;
  total: number | null;
  added_at: number;
}

interface MediaState {
  initialized: boolean;
  nextEpisode: number | null;
  airingAt: number | null;
  lastEpisodeKey: string | null;
  lastSeason: number | null;
  nextEpisodeKey: string | null;
  nextAirDate: string | null;
  releases: Record<string, string>;
  notified: string[];
}

/** "+3", "5", "S2E5", "s2 e5" → Fortschritt. */
export function parseProgress(input: string | undefined, current: { episode: number; season: number }): { episode: number; season: number } | undefined {
  const t = (input ?? '+1').trim().toLowerCase();
  const se = /^s(\d{1,3})\s*e(\d{1,4})$/.exec(t);
  if (se) return { season: Number(se[1]), episode: Number(se[2]) };
  const plus = /^\+(\d{1,4})$/.exec(t);
  if (plus) return { ...current, episode: current.episode + Number(plus[1]) };
  const abs = /^(\d{1,4})$/.exec(t);
  if (abs) return { ...current, episode: Number(abs[1]) };
  return undefined;
}

const TYPE_EMOJI: Record<MediaType, string> = { anime: '🎌', tv: '📺', movie: '🎬' };

export default defineCog({
  setup(cog: Cog) {
    const T = cog.tablePrefix + 'entries';
    cog.migrate([
      `CREATE TABLE IF NOT EXISTS ${T} (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, source TEXT NOT NULL, media_type TEXT NOT NULL, ext_id TEXT NOT NULL,
        title TEXT NOT NULL, status TEXT NOT NULL, episode INTEGER NOT NULL DEFAULT 0, season INTEGER NOT NULL DEFAULT 1,
        rating INTEGER, total INTEGER, added_at INTEGER NOT NULL, UNIQUE (user_id, source, media_type, ext_id))`,
    ]);
    cog.config.registerUser({ notify: 'dm' as 'dm' | 'channel' | 'off', guildId: null as string | null, channelId: null as string | null });
    cog.config.registerCustom('media', {
      initialized: false, nextEpisode: null, airingAt: null, lastEpisodeKey: null, lastSeason: null,
      nextEpisodeKey: null, nextAirDate: null, releases: {}, notified: [],
    } satisfies MediaState as unknown as Record<string, unknown>);
    const db = cog.db;
    const q = {
      insert: db.prepare(`INSERT OR IGNORE INTO ${T} (user_id, source, media_type, ext_id, title, status, total, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
      byUser: db.prepare(`SELECT * FROM ${T} WHERE user_id = ? ORDER BY id`),
      update: db.prepare(`UPDATE ${T} SET status = ?, episode = ?, season = ?, rating = ?, total = ? WHERE id = ?`),
      del: db.prepare(`DELETE FROM ${T} WHERE id = ?`),
      tracked: db.prepare(`SELECT * FROM ${T} WHERE status IN ('watching','planned','paused')`),
    };
    const tmdbKey = process.env.TMDB_API_KEY?.trim();
    const p = () => cog.platform;

    // ------------------------------------------------------------------ Quellen
    async function anilist<T>(query: string, variables: Record<string, unknown>): Promise<T> {
      const res = await fetchJson<{ data: T; errors?: Array<{ message: string }> }>('https://graphql.anilist.co', { json: { query, variables }, signal: cog.signal });
      if (res.errors?.length) throw new Error(res.errors[0]!.message);
      return res.data;
    }
    async function tmdb<T>(path: string, params: Record<string, string> = {}): Promise<T> {
      if (!tmdbKey) throw new UserError(cog.t('noTmdb'));
      const q = new URLSearchParams({ language: 'de-DE', ...params });
      const bearer = tmdbKey.length > 40; // v4-Lesetoken statt v3-Key
      if (!bearer) q.set('api_key', tmdbKey);
      return fetchJson<T>(`https://api.themoviedb.org/3${path}?${q}`, { headers: bearer ? { Authorization: `Bearer ${tmdbKey}` } : {}, signal: cog.signal });
    }

    async function search(term: string, only?: MediaType): Promise<SearchHit[]> {
      const hits: SearchHit[] = [];
      if (!only || only === 'anime') {
        const data = await anilist<{ Page: { media: Array<{ id: number; title: { romaji: string; english: string | null }; episodes: number | null; seasonYear: number | null; coverImage: { medium: string } }> } }>(
          `query($q:String){Page(perPage:5){media(search:$q,type:ANIME){id title{romaji english} episodes seasonYear coverImage{medium}}}}`,
          { q: term },
        ).catch(() => ({ Page: { media: [] } }));
        for (const m of data.Page.media) hits.push({ source: 'anilist', type: 'anime', id: String(m.id), title: m.title.english || m.title.romaji, year: m.seasonYear, total: m.episodes, image: m.coverImage?.medium ?? null });
      }
      if (tmdbKey && only !== 'anime') {
        const data = await tmdb<{ results: Array<{ id: number; media_type: string; title?: string; name?: string; release_date?: string; first_air_date?: string; poster_path?: string | null }> }>('/search/multi', { query: term }).catch(() => ({ results: [] }));
        for (const r of data.results) {
          const type: MediaType | null = r.media_type === 'tv' ? 'tv' : r.media_type === 'movie' ? 'movie' : null;
          if (!type || (only && only !== type)) continue;
          const date = r.release_date || r.first_air_date;
          hits.push({ source: 'tmdb', type, id: String(r.id), title: r.title ?? r.name ?? '?', year: date ? Number(date.slice(0, 4)) : null, total: null, image: r.poster_path ? `https://image.tmdb.org/t/p/w185${r.poster_path}` : null });
        }
      }
      return hits.slice(0, 5);
    }

    // ------------------------------------------------------------------ Benachrichtigung
    async function notifyUser(userId: string, text: string): Promise<void> {
      const c = cog.config.user(userId);
      const mode = c.get<string>('notify');
      if (mode === 'off') return;
      const channel = c.get<string | null>('channelId');
      if (mode === 'channel' && channel) {
        await cog.bot.send(channel, { content: `<@${userId}> ${text}`, allowed_mentions: { users: [userId] } }, c.get<string | null>('guildId') ?? undefined).catch(() => p().sendDM(userId, text));
      } else await p().sendDM(userId, text).catch(() => undefined);
    }
    const notifyAll = async (entries: Entry[], text: (e: Entry) => string) => {
      for (const e of entries) await notifyUser(e.user_id, text(e));
    };

    /** Prüft alle beobachteten Titel auf neue Folgen, Staffeln und Starts. */
    async function checkReleases(): Promise<void> {
      const tracked = q.tracked.all() as Entry[];
      const group = new Map<string, Entry[]>();
      for (const e of tracked) group.set(`${e.source}:${e.media_type}:${e.ext_id}`, [...(group.get(`${e.source}:${e.media_type}:${e.ext_id}`) ?? []), e]);
      const now = Date.now();
      const today = new Date().toISOString().slice(0, 10);

      // Animes gesammelt über AniList
      const animeIds = [...group.keys()].filter((k) => k.startsWith('anilist:')).map((k) => Number(k.split(':')[2]));
      for (let i = 0; i < animeIds.length; i += 50) {
        const data = await anilist<{ Page: { media: Array<{ id: number; episodes: number | null; nextAiringEpisode: { episode: number; airingAt: number } | null }> } }>(
          `query($ids:[Int]){Page(perPage:50){media(id_in:$ids,type:ANIME){id episodes nextAiringEpisode{episode airingAt}}}}`,
          { ids: animeIds.slice(i, i + 50) },
        ).catch((err) => {
          cog.log.warn({ err }, 'AniList-Abfrage fehlgeschlagen');
          return { Page: { media: [] } };
        });
        for (const m of data.Page.media) {
          const key = `anilist:anime:${m.id}`;
          const st = cog.config.custom('media', key);
          const s = st.all() as unknown as MediaState;
          const entries = group.get(key) ?? [];
          if (s.initialized && s.nextEpisode && s.airingAt && s.airingAt * 1000 <= now && !s.notified.includes(`ep${s.nextEpisode}`)) {
            const ep = s.nextEpisode;
            await notifyAll(entries, (e) => cog.t('newEpisode', { title: e.title, episode: ep }));
            st.set('notified', [...s.notified, `ep${ep}`].slice(-50));
          }
          st.setAll({ initialized: true, nextEpisode: m.nextAiringEpisode?.episode ?? null, airingAt: m.nextAiringEpisode?.airingAt ?? null });
        }
      }

      // Serien und Filme über TMDB
      if (!tmdbKey) return;
      for (const [key, entries] of group) {
        if (!key.startsWith('tmdb:')) continue;
        const [, type, id] = key.split(':') as [string, MediaType, string];
        const st = cog.config.custom('media', key);
        const s = st.all() as unknown as MediaState;
        try {
          if (type === 'tv') {
            const tv = await tmdb<{ number_of_seasons: number; last_episode_to_air: { season_number: number; episode_number: number; air_date: string; name: string } | null; next_episode_to_air: { season_number: number; episode_number: number; air_date: string } | null }>(`/tv/${id}`);
            const last = tv.last_episode_to_air;
            const lastKey = last ? `S${last.season_number}E${last.episode_number}` : null;
            if (s.initialized && lastKey && lastKey !== s.lastEpisodeKey && last!.air_date <= today) {
              const newSeason = s.lastSeason !== null && last!.season_number > s.lastSeason;
              await notifyAll(entries, (e) => cog.t(newSeason ? 'newSeason' : 'newTvEpisode', { title: e.title, season: last!.season_number, episode: last!.episode_number, name: last!.name ?? '' }));
            }
            const next = tv.next_episode_to_air;
            st.setAll({ initialized: true, lastEpisodeKey: lastKey, lastSeason: last?.season_number ?? s.lastSeason, nextEpisodeKey: next ? `S${next.season_number}E${next.episode_number}` : null, nextAirDate: next?.air_date ?? null });
          } else {
            const mv = await tmdb<{ release_date: string; release_dates?: { results: Array<{ iso_3166_1: string; release_dates: Array<{ type: number; release_date: string }> }> } }>(`/movie/${id}`, { append_to_response: 'release_dates' });
            const de = mv.release_dates?.results.find((r) => r.iso_3166_1 === 'DE')?.release_dates ?? [];
            const releases: Record<string, string> = {};
            const theatrical = de.find((r) => r.type === 3)?.release_date ?? mv.release_date;
            const digital = de.find((r) => r.type === 4)?.release_date;
            if (theatrical) releases.theatrical = theatrical.slice(0, 10);
            if (digital) releases.digital = digital.slice(0, 10);
            const notified = new Set(s.notified);
            for (const [kind, date] of Object.entries(releases)) {
              const nkey = `${kind}:${date}`;
              if (date > today || notified.has(nkey)) continue;
              // Beim ersten Abruf vergangene Starts nur merken, nicht melden
              if (s.initialized) await notifyAll(entries, (e) => cog.t(`release.${kind}`, { title: e.title }));
              notified.add(nkey);
            }
            st.setAll({ initialized: true, releases, notified: [...notified].slice(-20) });
          }
        } catch (err) {
          cog.log.debug({ err, key }, 'TMDB-Abfrage fehlgeschlagen');
        }
        await new Promise((r) => setTimeout(r, 300));
      }
    }

    cog.schedule({ name: 'release-check', every: 1800, runOnStart: false, run: () => checkReleases() });

    // ------------------------------------------------------------------ Befehle
    const entriesOf = (userId: string) => q.byUser.all(userId) as Entry[];
    const findEntry = (ctx: CommandContext, ref: string): Entry => {
      const list = entriesOf(ctx.author.id);
      const n = Number(ref);
      if (Number.isInteger(n) && n >= 1 && n <= list.length) return list[n - 1]!;
      const lower = ref.toLowerCase();
      const hits = list.filter((e) => e.title.toLowerCase().includes(lower));
      if (hits.length === 1) return hits[0]!;
      if (hits.length > 1) throw new UserError(ctx.t('ambiguous', { titles: hits.slice(0, 5).map((h) => h.title).join(', ') }));
      throw new UserError(ctx.t('notFound', { ref }));
    };
    const save = (e: Entry) => q.update.run(e.status, e.episode, e.season, e.rating, e.total, e.id);
    const progressText = (e: Entry) => (e.media_type === 'movie' ? '' : e.media_type === 'tv' ? `S${e.season}E${e.episode}` : `${e.episode}${e.total ? `/${e.total}` : ''}`);
    const refOpt = { name: 'eintrag', description: 'Nummer aus der Liste oder Teil des Titels', type: OptionType.String, required: true } as const;
    const typeWords: Record<string, MediaType> = { anime: 'anime', serie: 'tv', serien: 'tv', tv: 'tv', film: 'movie', movie: 'movie', filme: 'movie' };

    cog.group({
      name: 'watch',
      description: 'Deine Watchlist für Animes, Serien und Filme.',
      aliases: ['anime', 'watchlist'],
      subcommands: [
        {
          name: 'add',
          description: 'Titel suchen und hinzufügen (optional: anime/serie/film davor).',
          aliases: ['search', 'suche'],
          cooldown: { rate: 5, per: 60, bucket: 'user' },
          options: [{ name: 'titel', description: '[anime|serie|film] Titel', type: OptionType.String, required: true, rest: true }],
          examples: ['watch add Frieren', 'watch add serie Dark', 'watch add film Dune'],
          run: async (ctx) => {
            let term = ctx.arg<string>('titel').trim();
            const first = term.split(/\s+/)[0]!.toLowerCase();
            const only = typeWords[first];
            if (only) term = term.slice(first.length).trim();
            if (!term) throw new UserError(ctx.t('needTitle'));
            if (only && only !== 'anime' && !tmdbKey) throw new UserError(ctx.t('noTmdb'));
            await ctx.typing();
            const hits = await search(term, only);
            if (!hits.length) throw new UserError(ctx.t('noHits'));
            const list = hits.map((h, i) => `${NUMBER_EMOJIS[i]} ${TYPE_EMOJI[h.type]} **${h.title}**${h.year ? ` (${h.year})` : ''}${h.total ? ` · ${h.total} ${ctx.t('episodes')}` : ''}`).join('\n');
            const idx = hits.length === 1 ? 0 : await ctx.choose(embed({ title: ctx.t('chooseTitle'), description: list, thumbnail: hits[0]!.image ?? undefined }), hits.length);
            if (idx === null) return ctx.reply(ctx.t('common.cancelled'));
            const h = hits[idx]!;
            const r = q.insert.run(ctx.author.id, h.source, h.type, h.id, h.title, 'planned', h.total, Date.now());
            if (!r.changes) throw new UserError(ctx.t('already', { title: h.title }));
            await ctx.reply(ctx.t('added', { title: h.title, prefix: ctx.prefix }));
          },
        },
        {
          name: 'status',
          description: 'Status setzen: schaue, fertig, geplant, pausiert, abgebrochen.',
          options: [refOpt, { name: 'status', description: 'schaue/fertig/geplant/pausiert/abgebrochen', type: OptionType.String, required: true }],
          run: async (ctx) => {
            const e = findEntry(ctx, ctx.arg<string>('eintrag'));
            const status = STATUSES[ctx.arg<string>('status').toLowerCase()];
            if (!status) throw new UserError(ctx.t('badStatus'));
            save({ ...e, status, episode: status === 'completed' && e.total ? e.total : e.episode });
            await ctx.reply(ctx.t('statusSet', { title: e.title, status: ctx.t(`statuses.${status}`) }));
          },
        },
        {
          name: 'progress',
          description: 'Fortschritt: ohne Angabe +1 Folge, sonst +3, 12 oder S2E5.',
          aliases: ['p', 'weiter'],
          options: [refOpt, { name: 'folge', description: '+n, Folge oder SxEy', type: OptionType.String }],
          run: async (ctx) => {
            const e = findEntry(ctx, ctx.arg<string>('eintrag'));
            if (e.media_type === 'movie') throw new UserError(ctx.t('movieNoProgress'));
            const next = parseProgress(ctx.arg<string | undefined>('folge'), e);
            if (!next) throw new UserError(ctx.t('badProgress'));
            const finished = e.total !== null && next.episode >= e.total;
            const status: Status = finished ? 'completed' : e.status === 'planned' ? 'watching' : e.status;
            save({ ...e, ...next, status });
            await ctx.reply(ctx.t(finished ? 'progressDone' : 'progressSet', { title: e.title, progress: progressText({ ...e, ...next }) }));
          },
        },
        {
          name: 'rate',
          description: 'Bewertung 1–10.',
          options: [refOpt, { name: 'note', description: '1–10', type: OptionType.Integer, required: true, min_value: 1, max_value: 10 }],
          run: async (ctx) => {
            const e = findEntry(ctx, ctx.arg<string>('eintrag'));
            save({ ...e, rating: ctx.arg<number>('note') });
            await ctx.reply(ctx.t('rated', { title: e.title, rating: ctx.arg<number>('note') }));
          },
        },
        {
          name: 'list',
          description: 'Watchlist anzeigen (optional nach Status oder von jemand anderem).',
          options: [
            { name: 'status', description: 'Status (optional)', type: OptionType.String },
            { name: 'user', description: 'Mitglied (optional)', type: OptionType.User },
          ],
          run: async (ctx) => {
            const user = ctx.arg<ResolvedUser | undefined>('user') ?? { id: ctx.author.id, user: ctx.author };
            const statusRaw = ctx.arg<string | undefined>('status');
            const filter = statusRaw ? STATUSES[statusRaw.toLowerCase()] : undefined;
            if (statusRaw && !filter) throw new UserError(ctx.t('badStatus'));
            const all = entriesOf(user.id);
            const lines = all
              .map((e, i) => ({ e, i }))
              .filter(({ e }) => !filter || e.status === filter)
              .map(({ e, i }) => `\`${i + 1}\` ${TYPE_EMOJI[e.media_type]} **${e.title}** – ${ctx.t(`statuses.${e.status}`)}${progressText(e) ? ` · ${progressText(e)}` : ''}${e.rating ? ` · ⭐${e.rating}` : ''}`);
            if (!lines.length) return ctx.reply(ctx.t('emptyList', { prefix: ctx.prefix }));
            await ctx.paginate(pagify(lines.join('\n'), { pageLength: 1800 }).map((pg) => embed({ title: ctx.t('listTitle', { name: user.user?.username ?? user.id }), description: pg, color: 0xe91e63 })));
          },
        },
        {
          name: 'remove',
          description: 'Eintrag entfernen.',
          aliases: ['del', 'delete'],
          options: [refOpt],
          run: async (ctx) => {
            const e = findEntry(ctx, ctx.arg<string>('eintrag'));
            q.del.run(e.id);
            await ctx.reply(ctx.t('removed', { title: e.title }));
          },
        },
        {
          name: 'upcoming',
          description: 'Kommende Folgen und Starts deiner Titel.',
          aliases: ['kommend'],
          run: async (ctx) => {
            const items: Array<{ at: number; text: string }> = [];
            for (const e of entriesOf(ctx.author.id)) {
              if (e.status === 'completed' || e.status === 'dropped') continue;
              const s = cog.config.custom('media', `${e.source}:${e.media_type}:${e.ext_id}`).all() as unknown as MediaState;
              if (e.media_type === 'anime' && s.airingAt) items.push({ at: s.airingAt * 1000, text: ctx.t('upAnime', { title: e.title, episode: s.nextEpisode ?? '?' }) });
              if (e.media_type === 'tv' && s.nextAirDate) items.push({ at: new Date(`${s.nextAirDate}T12:00:00`).getTime(), text: ctx.t('upTv', { title: e.title, ep: s.nextEpisodeKey ?? '' }) });
              if (e.media_type === 'movie') {
                for (const [kind, date] of Object.entries(s.releases ?? {})) {
                  const at = new Date(`${date}T12:00:00`).getTime();
                  if (at > Date.now()) items.push({ at, text: ctx.t(`up.${kind}`, { title: e.title }) });
                }
              }
            }
            const future = items.filter((i) => i.at > Date.now() - 3600_000).sort((a, b) => a.at - b.at).slice(0, 20);
            if (!future.length) return ctx.reply(ctx.t('noUpcoming'));
            await ctx.sendEmbed({ title: ctx.t('upcomingTitle'), description: future.map((i) => `• ${formatDateTime(i.at)} (${relativeTime(i.at)}) – ${i.text}`).join('\n'), color: 0xe91e63 });
          },
        },
        {
          name: 'notify',
          description: 'Benachrichtigungen: dm, kanal (im Server ausführen) oder aus.',
          options: [
            {
              name: 'ziel',
              description: 'dm, kanal oder aus',
              type: OptionType.String,
              required: true,
              choices: [
                { name: 'dm', value: 'dm' },
                { name: 'kanal', value: 'channel' },
                { name: 'aus', value: 'off' },
              ],
            },
          ],
          run: async (ctx) => {
            const target = ctx.arg<'dm' | 'channel' | 'off'>('ziel');
            if (target === 'channel' && !ctx.guildId) throw new UserError(ctx.t('channelInGuild'));
            cog.config.user(ctx.author.id).setAll({ notify: target, guildId: target === 'channel' ? ctx.guildId! : null, channelId: target === 'channel' ? ctx.channelId : null });
            await ctx.reply(ctx.t(`notify.${target}`, { channel: `<#${ctx.channelId}>` }));
          },
        },
        {
          name: 'check',
          description: 'Jetzt auf Neuerscheinungen prüfen (Owner).',
          permissions: { level: 'owner' },
          run: async (ctx) => {
            await ctx.typing();
            await checkReleases();
            await ctx.tick();
          },
        },
      ],
    });
  },
});
