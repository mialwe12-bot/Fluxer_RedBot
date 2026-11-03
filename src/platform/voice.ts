/**
 * Voice-Fähigkeiten von Bots auf Fluxer (Stand der Recherche, siehe README „Fluxer-Einschränkungen“):
 *
 * - Voice-State-Updates (VOICE_STATE_UPDATE) empfangen: ja – Teil des Gateways, inkl. self_deaf/self_mute.
 * - Mitglieder verschieben: ja (angenommen) – PATCH /guilds/{id}/members/{user} mit channel_id,
 *   wie bei Discord; @fluxerjs/core unterstützt das Feld. Benötigt "Mitglieder verschieben".
 * - Audio senden: Fluxer nutzt LiveKit. Der Bot sendet op 4 (Voice State Update), erhält per
 *   VOICE_SERVER_UPDATE einen Grant (endpoint + token, 600 s gültig) und spricht dann LiveKit.
 *   Umgesetzt in voiceService.ts mit LiveKitRtcConnection aus @fluxerjs/voice (experimentell,
 *   gegen eine echte Instanz ungetestet). Fehler werden als VoiceUnsupportedError gemeldet.
 */
export class VoiceUnsupportedError extends Error {
  constructor(detail?: string) {
    super(detail ? `Sprachausgabe nicht möglich: ${detail}` : 'Sprachausgabe (Audio) ist auf dieser Instanz nicht verfügbar.');
    this.name = 'VoiceUnsupportedError';
  }
}

export interface VoiceCapabilities {
  receiveVoiceStates: boolean;
  moveMembers: boolean;
  playAudio: boolean;
}

export const VOICE_CAPABILITIES: VoiceCapabilities = {
  receiveVoiceStates: true,
  moveMembers: true,
  /** Experimentell über @fluxerjs/voice (LiveKit), siehe voiceService.ts. */
  playAudio: true,
};

/** Platzhalter für die spätere Audio-Anbindung (LiveKit). */
export class VoiceConnectionStub {
  async join(_guildId: string, _channelId: string): Promise<never> {
    throw new VoiceUnsupportedError();
  }
  async play(_source: string): Promise<never> {
    throw new VoiceUnsupportedError();
  }
  async leave(): Promise<void> {
    /* nichts zu tun */
  }
}
