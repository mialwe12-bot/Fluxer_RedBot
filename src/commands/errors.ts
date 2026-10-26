import type { Vars } from '../i18n/i18n.js';

/**
 * Fehler mit lesbarer, übersetzbarer Meldung. `key` ist ein i18n-Schlüssel im Kern-Namensraum
 * (oder im Cog-Namensraum, wenn der Cog ihn wirft); `vars` sind die Platzhalter.
 */
export class CommandError extends Error {
  constructor(
    readonly key: string,
    readonly vars: Vars = {},
  ) {
    super(key);
    this.name = 'CommandError';
  }
}

/** Falsche/fehlende Argumente – der Dispatcher zeigt zusätzlich die Verwendung an. */
export class ArgumentError extends CommandError {
  override name = 'ArgumentError';
}

/** Berechtigungsprüfung fehlgeschlagen. */
export class CheckFailure extends CommandError {
  override name = 'CheckFailure';
}

export class CooldownError extends CommandError {
  override name = 'CooldownError';
  constructor(readonly retryAfterSeconds: number) {
    super('errors.cooldown', { seconds: Math.ceil(retryAfterSeconds) });
  }
}

export class BotMissingPermissions extends CommandError {
  override name = 'BotMissingPermissions';
}

/**
 * Für Cogs: Fehler, dessen Text direkt (ohne Übersetzung) angezeigt wird.
 *   throw new UserError('Dieser Kanal ist bereits eingerichtet.');
 */
export class UserError extends Error {
  override name = 'UserError';
}
