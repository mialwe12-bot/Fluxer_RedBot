import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { defineCog, OptionType, UserError, type APIMessage, type Cog, type CommandContext } from '@bot/sdk';

const run = promisify(execFile);

/** Instagram-Links (Posts, Reels, IGTV) aus einem Text. */
export function extractInstagramUrls(text: string): string[] {
  const re = /https?:\/\/(?:www\.)?instagram\.com\/(?:[\w.]+\/)?(?:p|reel|reels|tv)\/([\w-]+)[^\s>]*/gi;
  return [...new Set([...text.matchAll(re)].map((m) => m[0]!.replace(/[)>\].,]+$/, '')))];
}

interface DownloadResult {
  files: Array<{ name: string; data: Buffer }>;
  skipped: number;
  title: string | null;
}

export default defineCog({
  setup(cog: Cog) {
    cog.config.registerGuild({ autoChannels: [] as string[], deleteOriginal: false });
    const env = process.env;
    const ytdlp = env.YTDLP_PATH || 'yt-dlp';
    const limitMb = Number(env.UPLOAD_LIMIT_MB ?? 25) || 25; // Annahme: Upload-Limit der Instanz
    const tmpRoot = path.join(cog.bot.env.dataDir, 'tmp', 'instadl');
    let running = 0;
    const MAX_PARALLEL = 2;

    async function download(url: string): Promise<DownloadResult> {
      if (running >= MAX_PARALLEL) throw new UserError(cog.t('busy'));
      running++;
      const dir = fs.mkdtempSync(path.join((fs.mkdirSync(tmpRoot, { recursive: true }), tmpRoot), 'dl-'));
      try {
        const args = [
          '--no-progress',
          '--no-warnings',
          '--restrict-filenames',
          '--max-filesize',
          `${limitMb}M`,
          '-f',
          'best[ext=mp4]/best',
          '-o',
          path.join(dir, '%(playlist_index|0)s_%(id)s.%(ext)s'),
          '--print-to-file',
          '%(title)s',
          path.join(dir, 'title.txt'),
        ];
        if (env.INSTAGRAM_COOKIES && fs.existsSync(env.INSTAGRAM_COOKIES)) args.push('--cookies', env.INSTAGRAM_COOKIES);
        args.push('--', url);
        try {
          await run(ytdlp, args, { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
        } catch (err) {
          const e = err as { code?: string; stderr?: string; message: string };
          if (e.code === 'ENOENT') throw new UserError(cog.t('noYtdlp'));
          const msg = (e.stderr || e.message).toLowerCase();
          if (msg.includes('login') || msg.includes('rate-limit') || msg.includes('cookies')) throw new UserError(cog.t('needLogin'));
          if (msg.includes('private')) throw new UserError(cog.t('private'));
          throw new UserError(cog.t('failed'));
        }
        const title = fs.existsSync(path.join(dir, 'title.txt')) ? fs.readFileSync(path.join(dir, 'title.txt'), 'utf8').split('\n')[0]!.trim() || null : null;
        const media = fs
          .readdirSync(dir)
          .filter((f) => /\.(mp4|mov|webm|jpe?g|png|webp|gif)$/i.test(f))
          .sort();
        const files: DownloadResult['files'] = [];
        let skipped = 0;
        for (const f of media.slice(0, 10)) {
          const stat = fs.statSync(path.join(dir, f));
          if (stat.size > limitMb * 1024 * 1024) {
            skipped++;
            continue;
          }
          files.push({ name: f.replace(/^\d+_/, ''), data: fs.readFileSync(path.join(dir, f)) });
        }
        skipped += Math.max(0, media.length - 10);
        return { files, skipped, title };
      } finally {
        running--;
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }

    async function post(channelId: string, guildId: string | undefined, url: string, reply?: APIMessage): Promise<void> {
      const result = await download(url);
      if (!result.files.length) throw new UserError(result.skipped ? cog.tg(guildId, 'tooBig', { limit: limitMb }) : cog.tg(guildId, 'noMedia'));
      // Mehrere Dateien gemeinsam hochladen; bei Fehler (z. B. Gesamtgröße) einzeln.
      const caption = `📸 <${url}>${result.title ? `\n${result.title.slice(0, 300)}` : ''}${result.skipped ? `\n${cog.tg(guildId, 'skipped', { count: result.skipped, limit: limitMb })}` : ''}`;
      const ref = reply ? { message_reference: { message_id: reply.id, channel_id: channelId, fail_if_not_exists: false } } : {};
      try {
        await cog.bot.send(channelId, { content: caption, files: result.files, allowed_mentions: { parse: [] }, ...ref }, guildId);
      } catch {
        await cog.bot.send(channelId, { content: caption, allowed_mentions: { parse: [] }, ...ref }, guildId);
        for (const f of result.files) await cog.bot.send(channelId, { files: [f] }, guildId).catch(() => undefined);
      }
    }

    cog.command({
      name: 'insta',
      description: 'Lädt einen Instagram-Post oder ein Reel herunter.',
      aliases: ['instagram', 'ig'],
      cooldown: { rate: 3, per: 60, bucket: 'user' },
      permissions: { level: 'everyone', bot: ['AttachFiles'] },
      options: [{ name: 'link', description: 'Instagram-Link', type: OptionType.String, required: true }],
      run: async (ctx) => {
        const url = extractInstagramUrls(ctx.arg<string>('link'))[0];
        if (!url) throw new UserError(ctx.t('badLink'));
        await ctx.typing();
        await post(ctx.channelId, ctx.guildId, url, ctx.message);
      },
    });

    // Automatisch in freigeschalteten Kanälen
    cog.on('MESSAGE_CREATE', async (m: APIMessage) => {
      if (!m.guild_id || !m.author || (m.author as { bot?: boolean }).bot) return;
      const conf = cog.config.guild(m.guild_id);
      if (!conf.get<string[]>('autoChannels').includes(m.channel_id)) return;
      if (cog.bot.prefixesFor(m.guild_id).some((pre) => (m.content ?? '').startsWith(pre))) return;
      const urls = extractInstagramUrls(m.content ?? '').slice(0, 3);
      if (!urls.length) return;
      await cog.platform.triggerTyping(m.channel_id).catch(() => undefined);
      let ok = 0;
      for (const url of urls) {
        try {
          await post(m.channel_id, m.guild_id, url, m);
          ok++;
        } catch (err) {
          cog.log.debug({ err, url }, 'Automatischer Instagram-Download fehlgeschlagen');
        }
      }
      if (ok && conf.get<boolean>('deleteOriginal')) await cog.platform.deleteMessage(m.channel_id, m.id).catch(() => undefined);
    });

    cog.group({
      name: 'instaset',
      description: 'Instagram-Downloader einrichten.',
      guildOnly: true,
      permissions: { level: 'admin', member: ['ManageGuild'] },
      subcommands: [
        {
          name: 'auto',
          description: 'Links in diesem Kanal automatisch herunterladen (umschalten).',
          options: [{ name: 'kanal', description: 'Kanal (Standard: dieser)', type: OptionType.Channel, channel_types: [0, 5] }],
          run: async (ctx: CommandContext) => {
            const id = ctx.arg<{ id: string } | undefined>('kanal')?.id ?? ctx.channelId;
            let on = false;
            cog.config.guild(ctx.guildId!).update<string[]>('autoChannels', (l) => {
              on = !l.includes(id);
              return on ? [...l, id] : l.filter((c) => c !== id);
            });
            await ctx.reply(ctx.t(on ? 'autoOn' : 'autoOff', { channel: `<#${id}>` }));
          },
        },
        {
          name: 'deleteoriginal',
          description: 'Originalnachricht nach erfolgreichem Auto-Download löschen.',
          permissions: { level: 'admin', member: ['ManageGuild'], bot: ['ManageMessages'] },
          options: [{ name: 'aktiv', description: 'an/aus', type: OptionType.Boolean, required: true }],
          run: async (ctx: CommandContext) => {
            cog.config.guild(ctx.guildId!).set('deleteOriginal', ctx.arg<boolean>('aktiv'));
            await ctx.tick();
          },
        },
        {
          name: 'version',
          description: 'Zeigt die yt-dlp-Version (Owner).',
          permissions: { level: 'owner' },
          run: async (ctx: CommandContext) => {
            const v = await run(ytdlp, ['--version'], { timeout: 15_000 }).then((r) => r.stdout.trim()).catch(() => null);
            await ctx.reply(v ? `yt-dlp ${v}` : ctx.t('noYtdlp'));
          },
        },
      ],
    });
  },
});
