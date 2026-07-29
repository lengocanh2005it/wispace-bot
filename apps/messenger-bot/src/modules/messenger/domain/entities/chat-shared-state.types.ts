import type { MessengerLinkContext } from '@messenger/shared/config/poc.constants';

export interface AppendChatBufferInput {
  psid: string;
  userText: string;
  userId?: number;
  linkContext?: MessengerLinkContext;
  idempotencyKey?: string;
  debounceMs: number;
}

export interface ChatQueueBufferSnapshot {
  psid: string;
  texts: string[];
  lastIdempotencyKey?: string;
  userId?: number;
  linkContext?: MessengerLinkContext;
}

export interface CompleteChatBufferInput {
  psid: string;
  debounceMs: number;
}
