import type {
  ChatQueueFlushHandler,
  DebounceChatQueueCallbacks,
  DebounceChatQueueConfig,
  EnqueueInput,
} from './types';

interface QueueState<TContext> {
  texts: string[];
  lastIdempotencyKey?: string;
  context?: Partial<TContext>;
  debounceTimer?: ReturnType<typeof setTimeout>;
  processing: boolean;
  pendingWhileProcessing: string[];
  lastPendingIdempotencyKey?: string;
  lastActivityAt: number;
}

/**
 * Framework-agnostic per-user debounce/merge state machine, shared across all
 * WISPACE bot platforms. Owns: buffering messages during the debounce
 * window, coalescing messages that arrive while a batch is being processed,
 * and evicting idle users. Everything content-specific — text
 * merging/capping, rate-limit reserve, LLM call, outbound delivery — happens
 * in the injected `ChatQueueFlushHandler`, not here.
 *
 * Memory-only (single process). A distributed backend (Redis buffer for
 * multi-pod deployments) is infra-specific and stays in each app, same as
 * `@wispace/chat-history`'s Redis store.
 */
export class DebounceChatQueue<TContext = Record<string, unknown>> {
  private static readonly DEFAULT_MAX_PENDING_SIZE = 20;
  private readonly queues = new Map<string, QueueState<TContext>>();
  private readonly cleanupTimer: ReturnType<typeof setInterval>;
  private readonly maxPendingSize: number;
  private readonly callbacks: DebounceChatQueueCallbacks<TContext>;

  constructor(
    private readonly config: DebounceChatQueueConfig,
    private readonly onFlush: ChatQueueFlushHandler<TContext>,
    callbacks: DebounceChatQueueCallbacks<TContext> = {},
  ) {
    this.maxPendingSize =
      Number.isFinite(config.maxPendingSize) && (config.maxPendingSize ?? 0) > 0
        ? Math.floor(config.maxPendingSize as number)
        : DebounceChatQueue.DEFAULT_MAX_PENDING_SIZE;
    this.callbacks = callbacks;
    this.cleanupTimer = setInterval(
      () => this.evictStale(),
      config.cleanupIntervalMs,
    );
    this.cleanupTimer.unref?.();
  }

  enqueue(input: EnqueueInput<TContext>): void {
    const text = input.text.trim();
    if (!text) {
      return;
    }

    let state = this.queues.get(input.externalUserId);
    if (!state) {
      state = {
        texts: [],
        processing: false,
        pendingWhileProcessing: [],
        lastActivityAt: Date.now(),
      };
      this.queues.set(input.externalUserId, state);
    }

    state.lastActivityAt = Date.now();
    if (input.context) {
      state.context = { ...state.context, ...input.context };
    }

    if (state.processing) {
      state.pendingWhileProcessing.push(text);
      if (input.idempotencyKey) {
        state.lastPendingIdempotencyKey = input.idempotencyKey;
      }

      this.callbacks.onPendingQueued?.(
        input.externalUserId,
        text,
        state.pendingWhileProcessing.length,
        state.context,
      );

      if (
        this.maxPendingSize > 0 &&
        state.pendingWhileProcessing.length > this.maxPendingSize
      ) {
        const excess =
          state.pendingWhileProcessing.length - this.maxPendingSize;
        state.pendingWhileProcessing.splice(0, excess);
        this.callbacks.onPendingDropped?.(input.externalUserId, excess);
      }

      return;
    }

    state.texts.push(text);
    if (state.texts.length > this.maxPendingSize) {
      const excess = state.texts.length - this.maxPendingSize;
      state.texts.splice(0, excess);
      this.callbacks.onPendingDropped?.(input.externalUserId, excess);
    }
    if (input.idempotencyKey) {
      state.lastIdempotencyKey = input.idempotencyKey;
    }
    this.scheduleFlush(input.externalUserId, state);
  }

  /** Flushes immediately if there is buffered text, bypassing the debounce wait. */
  async flushNow(externalUserId: string): Promise<void> {
    await this.flush(externalUserId);
  }

  /** Flushes every buffered user (best-effort) — used on graceful shutdown. */
  async drain(): Promise<void> {
    // Each flush can promote pendingWhileProcessing texts, so loop a few times
    // to drain those too; bounded so shutdown never spins forever.
    for (let round = 0; round < 3; round++) {
      const users = [...this.queues.keys()];
      if (users.length === 0) {
        return;
      }
      await Promise.allSettled(users.map((user) => this.flush(user)));
    }
  }

  async destroy(): Promise<void> {
    clearInterval(this.cleanupTimer);
    await this.drain();
    for (const state of this.queues.values()) {
      if (state.debounceTimer) {
        clearTimeout(state.debounceTimer);
        state.debounceTimer = undefined;
      }
    }
    this.queues.clear();
  }

  private scheduleFlush(
    externalUserId: string,
    state: QueueState<TContext>,
  ): void {
    if (state.debounceTimer) {
      clearTimeout(state.debounceTimer);
    }

    const timer = setTimeout(() => {
      if (state.debounceTimer === timer) {
        state.debounceTimer = undefined;
      }
      void this.flush(externalUserId);
    }, this.config.getDebounceMs());
    timer.unref?.();
    state.debounceTimer = timer;
  }

  private async flush(externalUserId: string): Promise<void> {
    const state = this.queues.get(externalUserId);
    if (!state || state.processing || !state.texts.length) {
      return;
    }

    state.processing = true;
    const texts = state.texts;
    state.texts = [];
    const context = state.context;
    const idempotencyKey = state.lastIdempotencyKey;
    state.lastIdempotencyKey = undefined;

    try {
      await this.onFlush({ externalUserId, texts, context, idempotencyKey });
    } finally {
      state.processing = false;

      if (state.pendingWhileProcessing.length > 0) {
        state.texts.push(...state.pendingWhileProcessing);
        state.pendingWhileProcessing = [];
        state.lastIdempotencyKey = state.lastPendingIdempotencyKey;
        state.lastPendingIdempotencyKey = undefined;
      }

      if (state.texts.length > 0) {
        this.scheduleFlush(externalUserId, state);
      } else if (
        !state.debounceTimer &&
        state.pendingWhileProcessing.length === 0
      ) {
        this.queues.delete(externalUserId);
      }
    }
  }

  private evictStale(): void {
    const cutoff = Date.now() - this.config.staleTtlMs;
    for (const [externalUserId, state] of this.queues) {
      if (
        !state.processing &&
        state.texts.length === 0 &&
        state.pendingWhileProcessing.length === 0 &&
        !state.debounceTimer &&
        state.lastActivityAt < cutoff
      ) {
        this.queues.delete(externalUserId);
      }
    }
  }
}
