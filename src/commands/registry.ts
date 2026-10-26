import { toApplicationCommand, type Command, type CommandDefinition } from './types.js';

const NAME_RE = /^[\p{Ll}\p{Lo}\p{N}_-]{1,32}$/u;

export class CommandConflictError extends Error {}

export interface ResolvedCommand {
  command: Command;
  /** Tatsächlich getippte Befehlskette, z. B. "set name". */
  invokedWith: string;
  /** Rest der Eingabe (Argumente). */
  argString: string;
}

/** Hält alle registrierten Befehle (inkl. Gruppen und Aliase). */
export class CommandRegistry {
  private readonly commands = new Map<string, Command>();
  private readonly aliases = new Map<string, Command>();

  /** Registriert einen Befehl (rekursiv mit Unterbefehlen). Wirft bei Namenskonflikten. */
  register(def: CommandDefinition, cogName: string, category: string): Command {
    const command = this.build(def, cogName, category, undefined);
    const names = [command.name, ...(command.aliases ?? [])];
    for (const n of names) {
      const existing = this.commands.get(n) ?? this.aliases.get(n);
      if (existing) {
        throw new CommandConflictError(
          `Befehl/Alias "${n}" (Cog ${cogName}) kollidiert mit "${existing.qualifiedName}" aus Cog ${existing.cogName}.`,
        );
      }
    }
    this.commands.set(command.name, command);
    for (const a of command.aliases ?? []) this.aliases.set(a, command);
    return command;
  }

  private build(def: CommandDefinition, cogName: string, category: string, parent: Command | undefined): Command {
    const name = def.name.toLowerCase();
    if (!NAME_RE.test(name)) throw new CommandConflictError(`Ungültiger Befehlsname "${def.name}".`);
    const command: Command = {
      ...def,
      name,
      aliases: (def.aliases ?? []).map((a) => a.toLowerCase()),
      qualifiedName: parent ? `${parent.qualifiedName} ${name}` : name,
      cogName,
      category,
      parent,
      children: new Map(),
      // Gruppen erben guildOnly/permissions, wenn nicht anders angegeben.
      guildOnly: def.guildOnly ?? parent?.guildOnly,
      permissions: def.permissions ?? parent?.permissions,
    };
    for (const sub of def.subcommands ?? []) {
      const child = this.build(sub, cogName, category, command);
      for (const n of [child.name, ...(child.aliases ?? [])]) {
        if (command.children.has(n) || [...command.children.values()].some((c) => c.aliases?.includes(n))) {
          throw new CommandConflictError(`Unterbefehl "${n}" in "${command.qualifiedName}" doppelt.`);
        }
      }
      command.children.set(child.name, child);
    }
    return command;
  }

  /** Entfernt alle Befehle eines Cogs. */
  unregisterCog(cogName: string): number {
    let count = 0;
    for (const [name, cmd] of this.commands) {
      if (cmd.cogName === cogName) {
        this.commands.delete(name);
        count++;
      }
    }
    for (const [alias, cmd] of this.aliases) if (cmd.cogName === cogName) this.aliases.delete(alias);
    return count;
  }

  get(name: string): Command | undefined {
    const n = name.toLowerCase();
    return this.commands.get(n) ?? this.aliases.get(n);
  }

  /** Sucht einen Befehl über seinen vollen Namen ("set name") oder einen Alias-Pfad. */
  find(path: string): Command | undefined {
    const parts = path.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let cmd = parts[0] ? this.get(parts[0]) : undefined;
    for (const part of parts.slice(1)) {
      if (!cmd) return undefined;
      cmd = findChild(cmd, part);
    }
    return cmd;
  }

  /** Ermittelt aus dem Text nach dem Prefix den tiefsten passenden (Unter-)Befehl. */
  resolve(text: string): ResolvedCommand | undefined {
    const match = /^\s*(\S+)/.exec(text);
    if (!match) return undefined;
    let command = this.get(match[1]!);
    if (!command) return undefined;
    let consumed = match[0].length;
    const invoked = [match[1]!.toLowerCase()];
    while (command.children.size > 0) {
      const next = /^\s+(\S+)/.exec(text.slice(consumed));
      if (!next) break;
      const child = findChild(command, next[1]!);
      if (!child) break;
      command = child;
      consumed += next[0].length;
      invoked.push(next[1]!.toLowerCase());
    }
    return { command, invokedWith: invoked.join(' '), argString: text.slice(consumed).trim() };
  }

  /** Alle Top-Level-Befehle. */
  all(): Command[] {
    return [...this.commands.values()];
  }

  byCog(cogName: string): Command[] {
    return this.all().filter((c) => c.cogName === cogName);
  }

  /** Alle Befehle inkl. Unterbefehle (Tiefensuche). */
  *walk(): Generator<Command> {
    const stack = [...this.all()].reverse();
    while (stack.length) {
      const cmd = stack.pop()!;
      yield cmd;
      stack.push(...[...cmd.children.values()].reverse());
    }
  }

  /** Native Application-Command-Definitionen (für spätere Slash-Commands). */
  exportApplicationCommands(): Record<string, unknown>[] {
    return this.all()
      .filter((c) => !c.hidden)
      .map((c) => toApplicationCommand(c));
  }
}

export function findChild(cmd: Command, name: string): Command | undefined {
  const n = name.toLowerCase();
  return cmd.children.get(n) ?? [...cmd.children.values()].find((c) => c.aliases?.includes(n));
}
