export interface EnqueueInput<TContext> {
  externalUserId: string;
  text: string;
  context?: Partial<TContext>;
  /** Idempotency key of this message — the last one in a debounce batch wins. */
  idempotencyKey?: string;
}

export interface ChatQueueBatch<TContext> {
  externalUserId: string;
  /** Raw texts accumulated during the debounce window, in arrival order. */
  texts: string[];
  context?: Partial<TContext>;
  idempotencyKey?: string;
}

/**
 * Platform-specific batch handler — merging/capping text, rate-limit
 * reserve, LLM call, and outbound delivery all happen here, not in the core.
 */
export type ChatQueueFlushHandler<TContext> = (
  batch: ChatQueueBatch<TContext>,
) => Promise<void>;

export interface DebounceChatQueueConfig {
  /** Debounce window before a batch is flushed; may change at runtime (env-driven). */
  getDebounceMs: () => number;
  /** A user with no activity for this long is evicted from memory. */
  staleTtlMs: number;
  /** How often to sweep for stale users. */
  cleanupIntervalMs: number;
  /**
   * Maximum messages allowed in `pendingWhileProcessing` per user. When
   * exceeded, the oldest pending messages are dropped. `0` = no cap.
   */
  maxPendingSize?: number;
}

export interface DebounceChatQueueCallbacks<TContext> {
  /**
   * Called when a message arrives while the previous batch is still being
   * processed (i.e. it lands in `pendingWhileProcessing`).
   */
  onPendingQueued?: (
    externalUserId: string,
    text: string,
    pendingCount: number,
    context?: Partial<TContext>,
  ) => void;
  /**
   * Called when pending messages are dropped because `maxPendingSize` was
   * exceeded. `droppedCount` is the number of messages removed.
   */
  onPendingDropped?: (externalUserId: string, droppedCount: number) => void;
}
