import type { CooldownSpec } from './types.js';

export interface CooldownKeyParts {
  userId: string;
  guildId?: string | undefined;
  channelId: string;
}

/** Sliding-Window-Cooldowns im Speicher (wie Red/discord.py: rate Aufrufe pro per Sekunden). */
export class CooldownManager {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  private key(commandName: string, spec: CooldownSpec, parts: CooldownKeyParts): string {
    switch (spec.bucket ?? 'user') {
      case 'global':
        return `${commandName}|g`;
      case 'guild':
        return `${commandName}|guild:${parts.guildId ?? `dm:${parts.userId}`}`;
      case 'channel':
        return `${commandName}|channel:${parts.channelId}`;
      case 'member':
        return `${commandName}|member:${parts.guildId ?? 'dm'}:${parts.userId}`;
      default:
        return `${commandName}|user:${parts.userId}`;
    }
  }

  /**
   * Registriert einen Aufruf. Gibt 0 zurück, wenn erlaubt, sonst die Wartezeit in Sekunden
   * (der Aufruf wird dann nicht gezählt).
   */
  hit(commandName: string, spec: CooldownSpec, parts: CooldownKeyParts): number {
    const key = this.key(commandName, spec, parts);
    const now = this.now();
    const windowMs = spec.per * 1000;
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (list.length >= spec.rate) {
      this.hits.set(key, list);
      return (list[0]! + windowMs - now) / 1000;
    }
    list.push(now);
    this.hits.set(key, list);
    return 0;
  }

  reset(commandName?: string): void {
    if (!commandName) {
      this.hits.clear();
      return;
    }
    for (const key of this.hits.keys()) if (key.startsWith(`${commandName}|`)) this.hits.delete(key);
  }

  /** Alte Einträge entfernen (wird periodisch aufgerufen). */
  sweep(maxAgeMs = 24 * 3600 * 1000): void {
    const now = this.now();
    for (const [key, list] of this.hits) {
      const fresh = list.filter((t) => now - t < maxAgeMs);
      if (fresh.length) this.hits.set(key, fresh);
      else this.hits.delete(key);
    }
  }
}
