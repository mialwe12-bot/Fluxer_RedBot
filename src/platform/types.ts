import type {
  APIChannel,
  APIEmbed,
  APIGuildMember,
  APIMessage,
  APIRole,
  APIUser,
  APIVoiceState,
} from '@fluxerjs/types';

export type { APIChannel, APIEmbed, APIGuildMember, APIMessage, APIRole, APIUser, APIVoiceState };

/** Minimales REST-Interface (von @fluxerjs/rest erfüllt, in Tests gefälscht). */
export interface RestLike {
  get<T>(route: string, options?: { auth?: boolean; unversioned?: boolean }): Promise<T>;
  post<T>(route: string, options?: RestRequestOptions): Promise<T>;
  patch<T>(route: string, options?: RestRequestOptions): Promise<T>;
  put<T>(route: string, options?: RestRequestOptions): Promise<T>;
  delete<T>(route: string, options?: RestRequestOptions): Promise<T>;
}

export interface RestRequestOptions {
  body?: unknown;
  files?: Array<{ name: string; data: Buffer | Uint8Array; filename?: string }>;
  reason?: string;
  auth?: boolean;
  headers?: Record<string, string>;
}

/** Minimales Gateway-Interface (von @fluxerjs/ws WebSocketManager erfüllt). */
export interface GatewayLike {
  connect(): Promise<void>;
  destroy(): void;
  send(shardId: number, payload: { op: number; d: unknown }): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

export interface PresenceData {
  status?: string;
  activities?: Array<{ name: string; type: number; url?: string | null }>;
  custom_status?: { text?: string | null } | null;
}

export interface CachedGuild {
  id: string;
  name: string;
  owner_id: string;
  icon: string | null;
  afk_channel_id: string | null;
  member_count: number;
  roles: Map<string, APIRole>;
  channels: Map<string, APIChannel>;
  members: Map<string, APIGuildMember>;
  voiceStates: Map<string, APIVoiceState>;
  presences: Map<string, PresenceData>;
}

export interface MessageFile {
  name: string;
  data: Buffer | Uint8Array;
}

/** Nutzlast zum Senden/Bearbeiten einer Nachricht. */
export interface MessagePayload {
  content?: string;
  embeds?: APIEmbed[];
  allowed_mentions?: { parse?: Array<'users' | 'roles' | 'everyone'>; users?: string[]; roles?: string[]; replied_user?: boolean };
  message_reference?: { message_id: string; channel_id?: string; guild_id?: string; fail_if_not_exists?: boolean };
  files?: MessageFile[];
}

export type BotStatus = 'online' | 'idle' | 'dnd' | 'invisible';

/** Fluxer-Dispatch-Events, die der Bot weiterreicht (Auszug, Discord-kompatible Namen). */
export type DispatchEvent =
  | 'READY'
  | 'RESUMED'
  | 'MESSAGE_CREATE'
  | 'MESSAGE_UPDATE'
  | 'MESSAGE_DELETE'
  | 'MESSAGE_DELETE_BULK'
  | 'MESSAGE_REACTION_ADD'
  | 'MESSAGE_REACTION_REMOVE'
  | 'MESSAGE_REACTION_REMOVE_ALL'
  | 'GUILD_CREATE'
  | 'GUILD_UPDATE'
  | 'GUILD_DELETE'
  | 'GUILD_MEMBER_ADD'
  | 'GUILD_MEMBER_UPDATE'
  | 'GUILD_MEMBER_REMOVE'
  | 'GUILD_BAN_ADD'
  | 'GUILD_BAN_REMOVE'
  | 'GUILD_ROLE_CREATE'
  | 'GUILD_ROLE_UPDATE'
  | 'GUILD_ROLE_DELETE'
  | 'CHANNEL_CREATE'
  | 'CHANNEL_UPDATE'
  | 'CHANNEL_DELETE'
  | 'VOICE_STATE_UPDATE'
  | 'PRESENCE_UPDATE'
  | 'TYPING_START'
  | 'INVITE_CREATE'
  | 'INVITE_DELETE'
  | (string & {});
