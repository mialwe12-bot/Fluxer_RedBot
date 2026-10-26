import type { Bot } from '../bot.js';
import type { Cog } from '../cogs/cog.js';
import type { CommandContext } from '../commands/context.js';
import { usageOf } from '../commands/parser.js';
import { OptionType, type Command, type CommandOption } from '../commands/types.js';
import { embed } from '../utils/embeds.js';
import type { Page } from '../utils/menus.js';

const TYPE_KEYS: Record<number, string> = {
  [OptionType.String]: 'help.types.string',
  [OptionType.Integer]: 'help.types.integer',
  [OptionType.Number]: 'help.types.number',
  [OptionType.Boolean]: 'help.types.boolean',
  [OptionType.User]: 'help.types.user',
  [OptionType.Channel]: 'help.types.channel',
  [OptionType.Role]: 'help.types.role',
  [OptionType.Mentionable]: 'help.types.mentionable',
  [OptionType.Attachment]: 'help.types.attachment',
};

/** Hilfe-Ausgabe: Übersicht nach Kategorien (Cogs), pro Cog und pro Befehl. */
export class HelpFormatter {
  constructor(private readonly bot: Bot) {}

  /** Darf der Aufrufer den Befehl ausführen? (ohne Cooldown, für die Filterung der Hilfe) */
  async canRun(ctx: CommandContext, command: Command): Promise<boolean> {
    if (command.hidden && !this.bot.isOwner(ctx.author.id)) return false;
    if (command.guildOnly && !ctx.guildId) return false;
    if (command.dmOnly && ctx.guildId) return false;
    const channel = ctx.guildId ? this.bot.platform.getChannel(ctx.channelId) : undefined;
    const result = await this.bot.permissions.check(command, {
      userId: ctx.author.id,
      guildId: ctx.guildId,
      channelId: ctx.channelId,
      categoryId: channel?.parent_id ?? null,
    });
    return result.allowed;
  }

  private async visible(ctx: CommandContext, commands: Command[]): Promise<Command[]> {
    const out: Command[] = [];
    for (const c of commands) if (await this.canRun(ctx, c)) out.push(c);
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Übersetzt Beschreibungen (i18n-Schlüssel oder deutscher Originaltext als Schlüssel). */
  private tr(ctx: CommandContext, cogName: string, text: string | undefined): string {
    if (!text) return '';
    return this.bot.i18n.t([`cog:${cogName}`, 'core'], text, {}, this.bot.localeFor(ctx.guildId));
  }

  private line(ctx: CommandContext, c: Command): string {
    return `\`${ctx.prefix}${c.qualifiedName}\` – ${this.tr(ctx, c.cogName, c.description)}`;
  }

  /** `!help` ohne Argument: eine Seite pro Kategorie. */
  async sendBotHelp(ctx: CommandContext): Promise<void> {
    const cogs = [...this.bot.cogs.loaded.values()]
      .filter((c) => !c.manifest.hidden)
      .sort((a, b) => (a.internal === b.internal ? a.displayName.localeCompare(b.displayName) : a.internal ? -1 : 1));
    const sections: Array<{ title: string; lines: string[] }> = [];
    for (const cog of cogs) {
      const cmds = await this.visible(ctx, this.bot.registry.byCog(cog.name));
      if (cmds.length) sections.push({ title: cog.displayName, lines: cmds.map((c) => this.line(ctx, c)) });
    }
    if (!sections.length) {
      await ctx.reply(ctx.t('help.nothing'));
      return;
    }
    // Kategorien zu Seiten zusammenfassen (max. ~1800 Zeichen pro Seite)
    const pages: Page[] = [];
    let fields: Array<{ name: string; value: string }> = [];
    let size = 0;
    const flush = () => {
      if (!fields.length) return;
      pages.push(
        embed({
          title: ctx.t('help.title', { name: this.bot.platform.user?.username ?? 'Bot' }),
          description: ctx.t('help.intro', { prefix: ctx.prefix }),
          fields,
        }),
      );
      fields = [];
      size = 0;
    };
    for (const s of sections) {
      // Ein Feld darf max. 1024 Zeichen haben – lange Kategorien teilen
      const chunks: string[] = [];
      let cur = '';
      for (const l of s.lines) {
        if (cur.length + l.length + 1 > 1000) {
          chunks.push(cur);
          cur = '';
        }
        cur += (cur ? '\n' : '') + l;
      }
      if (cur) chunks.push(cur);
      chunks.forEach((chunk, i) => {
        if (size + chunk.length > 1800 || fields.length >= 6) flush();
        fields.push({ name: i === 0 ? `📂 ${s.title}` : `📂 ${s.title} (${ctx.t('help.continued')})`, value: chunk });
        size += chunk.length;
      });
    }
    flush();
    await this.withPageFooters(ctx, pages);
  }

  async sendCogHelp(ctx: CommandContext, cog: Cog): Promise<void> {
    const cmds = await this.visible(ctx, this.bot.registry.byCog(cog.name));
    const lines = cmds.map((c) => this.line(ctx, c));
    const chunks: string[][] = [];
    for (let i = 0; i < lines.length; i += 15) chunks.push(lines.slice(i, i + 15));
    if (!chunks.length) chunks.push([ctx.t('help.noCommands')]);
    const footer = ctx.t('help.cogFooter', { version: cog.manifest.version, author: [cog.manifest.author].flat().join(', ') });
    const pages: Page[] = chunks.map((chunk, i) =>
      embed({
        title: `📂 ${cog.displayName}`,
        description: `${i === 0 ? `${this.tr(ctx, cog.name, cog.manifest.description)}\n\n` : ''}${chunk.join('\n')}`,
        footer,
      }),
    );
    await this.withPageFooters(ctx, pages);
  }

  private optionLine(ctx: CommandContext, cogName: string, o: CommandOption): string {
    const type = ctx.t(TYPE_KEYS[o.type] ?? 'help.types.string');
    const req = o.required ? ctx.t('help.required') : ctx.t('help.optional');
    let line = `\`${o.name}\` (${type}, ${req}) – ${this.tr(ctx, cogName, o.description)}`;
    if (o.choices?.length) line += `\n  ${ctx.t('help.choices')}: ${o.choices.map((c) => `\`${this.tr(ctx, cogName, c.name)}\``).join(', ')}`;
    if (o.default !== undefined) line += `\n  ${ctx.t('help.default')}: \`${String(o.default)}\``;
    return line;
  }

  async sendCommandHelp(ctx: CommandContext, command: Command): Promise<void> {
    const usage =
      command.children.size > 0 && !command.run
        ? `${ctx.prefix}${command.qualifiedName} <${ctx.t('help.subcommand')}>`
        : `${ctx.prefix}${command.qualifiedName} ${usageOf(command.options)}`.trim();
    const fields: Array<{ name: string; value: string; inline?: boolean }> = [];
    if (command.aliases?.length) fields.push({ name: ctx.t('help.aliases'), value: command.aliases.map((a) => `\`${a}\``).join(', '), inline: true });
    const level = command.permissions?.level;
    if (level && level !== 'everyone') fields.push({ name: ctx.t('help.permission'), value: ctx.t(`perm.levels.${level}`), inline: true });
    if (command.cooldown) {
      fields.push({
        name: ctx.t('help.cooldown'),
        value: ctx.t('help.cooldownValue', { rate: command.cooldown.rate, per: command.cooldown.per }),
        inline: true,
      });
    }
    if (command.options?.length) fields.push({ name: ctx.t('help.options'), value: command.options.map((o) => this.optionLine(ctx, command.cogName, o)).join('\n') });
    if (command.children.size) {
      const subs = await this.visible(ctx, [...command.children.values()]);
      if (subs.length) fields.push({ name: ctx.t('help.subcommands'), value: subs.map((c) => this.line(ctx, c)).join('\n') });
    }
    if (command.examples?.length) {
      fields.push({ name: ctx.t('help.examples'), value: command.examples.map((ex) => `\`${ctx.prefix}${ex}\``).join('\n') });
    }
    await ctx.sendEmbed(
      embed({
        title: usage,
        description: [this.tr(ctx, command.cogName, command.description), this.tr(ctx, command.cogName, command.help)].filter(Boolean).join('\n\n'),
        fields,
        footer: ctx.t('help.footer', { category: command.category }),
      }),
    );
  }

  private async withPageFooters(ctx: CommandContext, pages: Page[]): Promise<void> {
    if (pages.length > 1) {
      pages.forEach((p, i) => {
        if (typeof p !== 'string') p.footer = { text: ctx.t('help.page', { page: i + 1, total: pages.length }) };
      });
    }
    await ctx.paginate(pages);
  }
}
