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
  /** True when buffered messages were dropped (cap exceeded) since last flush. */
  droppedNoticePending?: boolean;
}

export interface CompleteChatBufferInput {
  psid: string;
  debounceMs: number;
}
