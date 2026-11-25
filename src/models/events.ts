import type { CloseReason, ThreadType } from './enums.js';
import type { Message } from './entities.js';
import type { ZapindError } from '../errors/index.js';

export interface ConnectionEvent {
  readonly connected: boolean;
  readonly code?: CloseReason | number;
  readonly reason?: string;
}

export interface ReactionEvent {
  readonly threadId: string;
  readonly threadType: ThreadType;
  readonly senderId: string;
  readonly icon: string;
  readonly targetMessageIds: readonly string[];
  readonly isSelf: boolean;
  readonly timestamp: Date;
}

export interface TypingEvent {
  readonly threadId: string;
  readonly threadType: ThreadType;
  readonly userId: string;
  readonly isSelf: boolean;
}

export interface SeenEvent {
  readonly threadId: string;
  readonly threadType: ThreadType;
  readonly messageIds: readonly string[];
  readonly seenBy: readonly string[];
}

export interface UndoEvent {
  readonly threadId: string;
  readonly threadType: ThreadType;
  readonly senderId: string;
  readonly messageId: string;
  readonly clientMsgId: string;
  readonly isSelf: boolean;
}

export interface GroupUpdateEvent {
  readonly groupId: string;
  readonly type: string;
  readonly actorId?: string;
  readonly targetIds: readonly string[];
  readonly data: Record<string, unknown>;
}

export interface UserUpdateEvent {
  readonly userId: string;
  readonly type: string;
  readonly data: Record<string, unknown>;
}

export interface AuthRequiredEvent {
  readonly reason: 'no_session' | 'session_expired';
  readonly error?: ZapindError;
}

export interface ZapindEventMap {
  message: Message;
  reaction: ReactionEvent;
  'group.update': GroupUpdateEvent;
  'user.update': UserUpdateEvent;
  typing: TypingEvent;
  seen: SeenEvent;
  undo: UndoEvent;
  'auth.required': AuthRequiredEvent;
  connected: ConnectionEvent;
  disconnected: ConnectionEvent;
  error: ZapindError;
}

export type ZapindEventName = keyof ZapindEventMap;
export type ZapindEventHandler<K extends ZapindEventName> = (
  payload: ZapindEventMap[K],
) => void | Promise<void>;
export type UnsubscribeFn = () => void;
