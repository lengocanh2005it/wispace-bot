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
  /** Fencing token for the worker that claimed this batch. */
  leaseToken: string;
  lastIdempotencyKey?: string;
  /** Number of automatic flush retries already attempted for this buffer. */
  retryCount: number;
  userId?: number;
  linkContext?: MessengerLinkContext;
  /** True when buffered messages were dropped (cap exceeded) since last flush. */
  droppedNoticePending?: boolean;
}

export interface CompleteChatBufferInput {
  psid: string;
  debounceMs: number;
  /** Only the worker that claimed the batch may complete it. */
  leaseToken: string;
}
