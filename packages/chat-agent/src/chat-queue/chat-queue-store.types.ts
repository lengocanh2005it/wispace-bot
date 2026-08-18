export interface AppendChatBufferInput {
  externalUserId: string;
  userText: string;
  userId?: number;
  context?: Record<string, unknown>;
  idempotencyKey?: string;
  debounceMs: number;
}

export interface ChatQueueBufferSnapshot {
  externalUserId: string;
  texts: string[];
  lastIdempotencyKey?: string;
  userId?: number;
  context?: Record<string, unknown>;
  /** True when buffered messages were dropped (cap exceeded) since last flush. */
  droppedNoticePending?: boolean;
}

export interface CompleteChatBufferInput {
  externalUserId: string;
  debounceMs: number;
}
