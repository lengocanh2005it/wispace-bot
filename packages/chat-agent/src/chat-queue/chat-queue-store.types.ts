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
  /** Fencing token for the worker that claimed this batch. */
  leaseToken: string;
  /** The key belonging to the claimed batch, retained across retry/recovery. */
  lastIdempotencyKey?: string;
  /** Number of automatic flush retries already attempted for this buffer. */
  retryCount: number;
  userId?: number;
  context?: Record<string, unknown>;
  /** True when buffered messages were dropped (cap exceeded) since last flush. */
  droppedNoticePending?: boolean;
}

export interface CompleteChatBufferInput {
  externalUserId: string;
  debounceMs: number;
  /** Only the worker that claimed the batch may complete it. */
  leaseToken: string;
}

export type ChatQueueRecoveryOutcome =
  | 'retry'
  | 'abandoned'
  | 'fenced_stale'
  | 'durable_recovery';

export interface ChatQueueReconciliationResult {
  status: 'clean' | 'drift' | 'partial' | 'unavailable' | 'locked';
  scanned: number;
  mismatches: number;
  repaired: number;
  quarantined: number;
  unresolved: number;
  truncated: boolean;
  /** Bounded, masked identifiers for operator follow-up. */
  sampleExternalIds: string[];
}
