import {
  defineCog,
  embed,
  formatDateTime,
  humanizeSeconds,
  OptionType,
  pagify,
  takeDuration,
  UserError,
  type APIRole,
  type Cog,
  type CommandContext,
} from '@bot/sdk';
import type { EconomyApi } from '../economy/index.js';
import type { GuardInfo, LoopMode, MusicApi, Track } from '../jellyfinmusic/index.js';
import { formatDuration } from '../jellyfinmusic/index.js';

interface StoredTrack {
  title: string;
  source: Track['source'];
  ref: string;
  duration: number | null;
}

interface PlaylistRow {
  guild_id: string;
  name: string;
  author_id: string;
  tracks: string;
  created_at: number;
  updated_at: number;
}

export interface AudioSettings {
  djRole: string | null;
  voteSkip: boolean;
  maxQueue: number;
  maxLength: number;
  jukebox: number;
}

const PLAYLIST_RE = /^[\p{L}\p{N}_-]{1,40}$/u;
const MAX_PLAYLIST = 500;

/**
 * Entscheidung der Audio-Regeln (rein, testbar).
 * - privileged: Mod/Admin oder Inhaber der DJ-Rolle → keine Limits, keine Jukebox-Kosten
 * - control: darf steuern (privileged, oder es gibt keine DJ-Rolle und keine Abstimmung)
 */
export function decide(
  s: AudioSettings,
  info: Pick<GuardInfo, 'action' | 'tracks' | 'queueLength'>,
  who: { privileged: boolean; control: boolean },
): { block?: string; vote?: true; charge?: true; vars?: Record<string, string | number> } {
  if (info.action === 'enqueue') {
    if (who.privileged) return {};
    const tracks = info.tracks ?? [];
    if (s.maxQueue > 0 && info.queueLength + tracks.length > s.maxQueue) return { block: 'guard.maxQueue', vars: { max: s.maxQueue } };
    if (s.maxLength > 0 && tracks.some((t) => t.duration !== null && t.duration > s.maxLength)) {
      return { block: 'guard.maxLength', vars: { max: humanizeSeconds(s.maxLength) } };
    }
    return s.jukebox > 0 ? { charge: true } : {};
  }
  if (who.control) return {};
  if (info.action === 'skip' && s.voteSkip) return { vote: true };
  return { block: 'guard.djOnly' };
}

export default defineCog({
  setup(cog: Cog) {
    const T = cog.tablePrefix + 'playlists';
    cog.migrate([
      `CREATE TABLE IF NOT EXISTS ${T} (guild_id TEXT NOT NULL, name TEXT NOT NULL, author_id TEXT NOT NULL, tracks TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (guild_id, name))`,
    ]);
    cog.config.registerGuild({ djRole: null, voteSkip: false, maxQueue: 0, maxLength: 0, jukebox: 0 } satisfies AudioSettings);
    const db = cog.db;
    const q = {
      get: db.prepare(`SELECT * FROM ${T} WHERE guild_id = ? AND name = ?`),
      list: db.prepare(`SELECT * FROM ${T} WHERE guild_id = ? ORDER BY name`),
      upsert: db.prepare(
        `INSERT INTO ${T} (guild_id, name, author_id, tracks, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (guild_id, name) DO UPDATE SET tracks = excluded.tracks, updated_at = excluded.updated_at`,
      ),
      rename: db.prepare(`UPDATE ${T} SET name = ? WHERE guild_id = ? AND name = ?`),
      del: db.prepare(`DELETE FROM ${T} WHERE guild_id = ? AND name = ?`),
    };
    const music = (): MusicApi => {
      const api = cog.bot.cogApi<MusicApi>('jellyfinmusic');
      if (!api) throw new UserError(cog.t('noMusic'));
      return api;
    };
    const settings = (g: string) => cog.config.guild(g).all() as unknown as AudioSettings;
    const p = () => cog.platform;

    /** privileged = Mod/Admin oder DJ-Rolle; control = darf steuern (ohne DJ-Rolle und Abstimmung: alle). */
    async function roleOf(guildId: string, userId: string): Promise<{ privileged: boolean; control: boolean }> {
      const s = settings(guildId);
      const mod = ['mod', 'admin', 'guildowner', 'owner'].includes(await cog.bot.levelOf(guildId, userId));
      const privileged = mod || Boolean(s.djRole && p().getMember(guildId, userId)?.roles.includes(s.djRole));
      return { privileged, control: privileged || (!s.djRole && !s.voteSkip) };
    }
    const isDj = async (guildId: string, userId: string) => (await roleOf(guildId, userId)).control;

    // ------------------------------------------------------------------ Regeln am Player
    const removeGuard = music().addGuard(async (info) => {
      const s = settings(info.guildId);
      const r = decide(s, info, await roleOf(info.guildId, info.userId));
      if (r.block) return cog.tg(info.guildId, r.block, r.vars);
      if (r.vote) return 'vote';
      // Jukebox: Titel kosten Geld (DJs/Mods frei)
      if (r.charge) {
        const eco = cog.bot.cogApi<EconomyApi>('economy');
        if (eco) {
          const price = s.jukebox * (info.tracks?.length ?? 1);
          if (!eco.canSpend(info.guildId, info.userId, price)) return cog.tg(info.guildId, 'guard.jukeboxPoor', { price: eco.format(info.guildId, price) });
          eco.withdraw(info.guildId, info.userId, price);
        }
      }
      return null;
    });
    cog.onUnload(() => removeGuard());

    const requireDj = async (ctx: CommandContext) => {
      if (!(await isDj(ctx.guildId!, ctx.author.id))) throw new UserError(ctx.t('guard.djOnly'));
    };
    const requireInVoice = (ctx: CommandContext): string => {
      const vc = p().getVoiceState(ctx.guildId!, ctx.author.id)?.channel_id;
      if (!vc) throw new UserError(ctx.t('joinVoice'));
      return vc;
    };

    // ------------------------------------------------------------------ Steuerung
    cog.command({
      name: 'repeat',
      description: 'Wiederholen: aus, titel oder liste.',
      aliases: ['loop'],
      guildOnly: true,
      options: [
        {
          name: 'modus',
          description: 'aus, titel oder liste',
          type: OptionType.String,
          required: true,
          choices: [
            { name: 'aus', value: 'off' },
            { name: 'titel', value: 'track' },
            { name: 'liste', value: 'queue' },
          ],
        },
      ],
      run: async (ctx) => {
        await requireDj(ctx);
        music().setLoop(ctx.guildId!, ctx.arg<LoopMode>('modus'));
        await ctx.reply(ctx.t(`repeat.${ctx.arg<LoopMode>('modus')}`));
      },
    });

    cog.command({
      name: 'shuffle',
      description: 'Warteschlange mischen.',
      aliases: ['mischen'],
      guildOnly: true,
      run: async (ctx) => {
        await requireDj(ctx);
        if (!music().queue(ctx.guildId!).length) throw new UserError(ctx.t('emptyQueue'));
        music().shuffle(ctx.guildId!);
        await ctx.reply(ctx.t('shuffled', { count: music().queue(ctx.guildId!).length }));
      },
    });

    cog.command({
      name: 'move',
      description: 'Titel in der Warteschlange verschieben.',
      guildOnly: true,
      options: [
        { name: 'von', description: 'Position', type: OptionType.Integer, required: true, min_value: 1 },
        { name: 'nach', description: 'neue Position', type: OptionType.Integer, required: true, min_value: 1 },
      ],
      run: async (ctx) => {
        await requireDj(ctx);
        const t = music().move(ctx.guildId!, ctx.arg<number>('von'), ctx.arg<number>('nach'));
        if (!t) throw new UserError(ctx.t('noSuchTrack'));
        await ctx.reply(ctx.t('moved', { title: t.title, pos: ctx.arg<number>('nach') }));
      },
    });

    cog.command({
      name: 'clearqueue',
      description: 'Warteschlange leeren (aktueller Titel läuft weiter).',
      aliases: ['clear-queue', 'leeren'],
      guildOnly: true,
      run: async (ctx) => {
        await requireDj(ctx);
        await ctx.reply(ctx.t('cleared', { count: music().clear(ctx.guildId!) }));
      },
    });

    cog.command({
      name: 'history',
      description: 'Zuletzt gespielte Titel.',
      aliases: ['verlauf'],
      guildOnly: true,
      run: async (ctx) => {
        const h = music().history(ctx.guildId!);
        if (!h.length) return ctx.reply(ctx.t('noHistory'));
        await ctx.sendEmbed({ title: ctx.t('historyTitle'), description: h.map((t, i) => `${i + 1}. ${t.title} (${formatDuration(t.duration)}) – <@${t.requester}>`).join('\n') });
      },
    });

    // ------------------------------------------------------------------ Playlists
    const nameOpt = { name: 'name', description: 'Name der Playlist', type: OptionType.String, required: true } as const;
    const getPl = (ctx: CommandContext, name: string): PlaylistRow => {
      const row = q.get.get(ctx.guildId, name.toLowerCase()) as PlaylistRow | undefined;
      if (!row) throw new UserError(ctx.t('pl.notFound', { name }));
      return row;
    };
    const tracksOf = (row: PlaylistRow) => JSON.parse(row.tracks) as StoredTrack[];
    const canEdit = async (ctx: CommandContext, row: PlaylistRow) => {
      if (row.author_id === ctx.author.id || (await roleOf(ctx.guildId!, ctx.author.id)).privileged) return;
      throw new UserError(ctx.t('pl.notYours'));
    };
    const store = (t: Track): StoredTrack => ({ title: t.title, source: t.source, ref: t.ref, duration: t.duration });
    const save = (ctx: CommandContext, name: string, tracks: StoredTrack[], existing?: PlaylistRow) => {
      if (tracks.length > MAX_PLAYLIST) throw new UserError(ctx.t('pl.tooLong', { max: MAX_PLAYLIST }));
      const now = Date.now();
      q.upsert.run(ctx.guildId, name.toLowerCase(), existing?.author_id ?? ctx.author.id, JSON.stringify(tracks), existing?.created_at ?? now, now);
    };
    const validName = (ctx: CommandContext, name: string) => {
      if (!PLAYLIST_RE.test(name)) throw new UserError(ctx.t('pl.badName'));
      return name.toLowerCase();
    };

    cog.group({
      name: 'playlist',
      description: 'Server-Playlists.',
      aliases: ['pl'],
      guildOnly: true,
      subcommands: [
        {
          name: 'play',
          description: 'Playlist in die Warteschlange (optional gemischt).',
          aliases: ['start'],
          options: [nameOpt, { name: 'gemischt', description: 'zufällige Reihenfolge', type: OptionType.Boolean, default: false }],
          run: async (ctx) => {
            const vc = requireInVoice(ctx);
            const row = getPl(ctx, ctx.arg<string>('name'));
            let tracks: Track[] = tracksOf(row).map((t) => ({ ...t, requester: ctx.author.id }));
            if (!tracks.length) throw new UserError(ctx.t('pl.empty'));
            if (ctx.arg<boolean>('gemischt')) {
              for (let i = tracks.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [tracks[i], tracks[j]] = [tracks[j]!, tracks[i]!];
              }
            }
            const s = settings(ctx.guildId!);
            if (s.maxQueue > 0 && !(await roleOf(ctx.guildId!, ctx.author.id)).privileged) tracks = tracks.slice(0, Math.max(0, s.maxQueue - music().queue(ctx.guildId!).length));
            if (!tracks.length) throw new UserError(ctx.t('guard.maxQueue', { max: s.maxQueue }));
            await music().enqueue(ctx.guildId!, vc, ctx.channelId, tracks);
            await ctx.reply(ctx.t('pl.queued', { name: row.name, count: tracks.length }));
          },
        },
        {
          name: 'save',
          description: 'Aktuellen Titel + Warteschlange als Playlist speichern.',
          options: [nameOpt],
          run: async (ctx) => {
            const name = validName(ctx, ctx.arg<string>('name'));
            const existing = q.get.get(ctx.guildId, name) as PlaylistRow | undefined;
            if (existing) await canEdit(ctx, existing);
            const cur = music().current(ctx.guildId!);
            const tracks = [...(cur ? [cur] : []), ...music().queue(ctx.guildId!)].map(store);
            if (!tracks.length) throw new UserError(ctx.t('emptyQueue'));
            save(ctx, name, tracks, existing);
            await ctx.reply(ctx.t('pl.saved', { name, count: tracks.length }));
          },
        },
        {
          name: 'create',
          description: 'Leere Playlist anlegen.',
          options: [nameOpt],
          run: async (ctx) => {
            const name = validName(ctx, ctx.arg<string>('name'));
            if (q.get.get(ctx.guildId, name)) throw new UserError(ctx.t('pl.exists', { name }));
            save(ctx, name, []);
            await ctx.reply(ctx.t('pl.created', { name, prefix: ctx.prefix }));
          },
        },
        {
          name: 'append',
          description: 'Titel/Playlist-Link/Suche anhängen (auch "jf: …" für Jellyfin).',
          aliases: ['add'],
          options: [nameOpt, { name: 'suche', description: 'Suche oder Link', type: OptionType.String, required: true, rest: true }],
          run: async (ctx) => {
            const row = getPl(ctx, ctx.arg<string>('name'));
            await canEdit(ctx, row);
            await ctx.typing();
            const found = await music().resolveQuery(ctx.arg<string>('suche'), ctx.author.id);
            save(ctx, row.name, [...tracksOf(row), ...found.map(store)], row);
            await ctx.reply(found.length === 1 ? ctx.t('pl.appendedOne', { title: found[0]!.title, name: row.name }) : ctx.t('pl.appended', { count: found.length, name: row.name }));
          },
        },
        {
          name: 'remove',
          description: 'Titel aus der Playlist entfernen.',
          options: [nameOpt, { name: 'nummer', description: 'Position', type: OptionType.Integer, required: true, min_value: 1 }],
          run: async (ctx) => {
            const row = getPl(ctx, ctx.arg<string>('name'));
            await canEdit(ctx, row);
            const tracks = tracksOf(row);
            const [t] = tracks.splice(ctx.arg<number>('nummer') - 1, 1);
            if (!t) throw new UserError(ctx.t('noSuchTrack'));
            save(ctx, row.name, tracks, row);
            await ctx.reply(ctx.t('pl.removedTrack', { title: t.title }));
          },
        },
        {
          name: 'show',
          description: 'Titel einer Playlist.',
          options: [nameOpt],
          run: async (ctx) => {
            const row = getPl(ctx, ctx.arg<string>('name'));
            const tracks = tracksOf(row);
            const total = tracks.reduce((s, t) => s + (t.duration ?? 0), 0);
            const lines = tracks.map((t, i) => `\`${i + 1}\` ${t.source === 'jellyfin' ? '🟣' : t.source === 'youtube' ? '🔴' : '🔗'} ${t.title} (${formatDuration(t.duration)})`);
            const head = ctx.t('pl.showHead', { author: `<@${row.author_id}>`, count: tracks.length, time: humanizeSeconds(total, 2), updated: formatDateTime(row.updated_at) });
            await ctx.paginate(pagify(lines.join('\n') || ctx.t('pl.empty'), { pageLength: 1600 }).map((pg) => embed({ title: `🎶 ${row.name}`, description: `${head}\n\n${pg}` })));
          },
        },
        {
          name: 'list',
          description: 'Alle Playlists dieses Servers.',
          run: async (ctx) => {
            const rows = q.list.all(ctx.guildId) as PlaylistRow[];
            if (!rows.length) return ctx.reply(ctx.t('pl.none', { prefix: ctx.prefix }));
            await ctx.sendEmbed({ title: ctx.t('pl.listTitle'), description: rows.map((r) => `**${r.name}** – ${tracksOf(r).length} ${ctx.t('pl.tracks')} – <@${r.author_id}>`).join('\n').slice(0, 4000) });
          },
        },
        {
          name: 'rename',
          description: 'Playlist umbenennen.',
          options: [nameOpt, { name: 'neu', description: 'Neuer Name', type: OptionType.String, required: true }],
          run: async (ctx) => {
            const row = getPl(ctx, ctx.arg<string>('name'));
            await canEdit(ctx, row);
            const neu = validName(ctx, ctx.arg<string>('neu'));
            if (q.get.get(ctx.guildId, neu)) throw new UserError(ctx.t('pl.exists', { name: neu }));
            q.rename.run(neu, ctx.guildId, row.name);
            await ctx.tick();
          },
        },
        {
          name: 'delete',
          description: 'Playlist löschen.',
          aliases: ['del'],
          options: [nameOpt],
          run: async (ctx) => {
            const row = getPl(ctx, ctx.arg<string>('name'));
            await canEdit(ctx, row);
            if (!(await ctx.confirm(ctx.t('pl.deleteConfirm', { name: row.name })))) return ctx.reply(ctx.t('common.cancelled'));
            q.del.run(ctx.guildId, row.name);
            await ctx.reply(ctx.t('pl.deleted', { name: row.name }));
          },
        },
      ],
    });

    // ------------------------------------------------------------------ Einstellungen
    cog.group({
      name: 'audioset',
      description: 'Audio-Einstellungen.',
      guildOnly: true,
      permissions: { level: 'admin', member: ['ManageGuild'] },
      run: async (ctx) => {
        const s = settings(ctx.guildId!);
        await ctx.sendEmbed({
          title: ctx.t('settingsTitle'),
          fields: [
            { name: ctx.t('s.dj'), value: s.djRole ? `<@&${s.djRole}>` : ctx.t('s.everyone'), inline: true },
            { name: ctx.t('s.voteSkip'), value: s.voteSkip ? '✅' : '❌', inline: true },
            { name: ctx.t('s.maxQueue'), value: s.maxQueue ? String(s.maxQueue) : '∞', inline: true },
            { name: ctx.t('s.maxLength'), value: s.maxLength ? humanizeSeconds(s.maxLength) : '∞', inline: true },
            { name: ctx.t('s.jukebox'), value: s.jukebox ? String(s.jukebox) : '–', inline: true },
          ],
          footer: ctx.t('settingsFooter'),
        });
      },
      subcommands: [
        {
          name: 'dj',
          description: 'DJ-Rolle (darf skip/stop/volume/repeat …; leer = alle).',
          options: [{ name: 'rolle', description: 'Rolle', type: OptionType.Role }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('djRole', ctx.arg<APIRole | undefined>('rolle')?.id ?? null);
            await ctx.tick();
          },
        },
        {
          name: 'voteskip',
          description: 'Nicht-DJs überspringen per Abstimmung (Mehrheit der Zuhörer).',
          options: [{ name: 'aktiv', description: 'an/aus', type: OptionType.Boolean, required: true }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('voteSkip', ctx.arg<boolean>('aktiv'));
            await ctx.tick();
          },
        },
        {
          name: 'maxqueue',
          description: 'Höchstzahl Titel in der Warteschlange (0 = unbegrenzt, DJs ausgenommen).',
          options: [{ name: 'anzahl', description: 'Anzahl', type: OptionType.Integer, required: true, min_value: 0, max_value: 5000 }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('maxQueue', ctx.arg<number>('anzahl'));
            await ctx.tick();
          },
        },
        {
          name: 'maxlength',
          description: 'Maximale Titellänge (z. B. 10m; "0" = unbegrenzt).',
          options: [{ name: 'dauer', description: 'Dauer', type: OptionType.String, required: true }],
          run: async (ctx) => {
            const raw = ctx.arg<string>('dauer');
            const secs = raw === '0' ? 0 : takeDuration(raw).seconds;
            if (secs === undefined) throw new UserError(ctx.t('badDuration'));
            cog.config.guild(ctx.guildId!).set('maxLength', secs);
            await ctx.tick();
          },
        },
        {
          name: 'jukebox',
          description: 'Preis pro Titel (braucht economy; 0 = kostenlos, DJs zahlen nie).',
          options: [{ name: 'preis', description: 'Preis', type: OptionType.Integer, required: true, min_value: 0 }],
          run: async (ctx) => {
            cog.config.guild(ctx.guildId!).set('jukebox', ctx.arg<number>('preis'));
            await ctx.reply(ctx.arg<number>('preis') && !ctx.bot.cogs.isLoaded('economy') ? ctx.t('needEconomy') : ctx.t('common.done'));
          },
        },
      ],
    });
  },
});
