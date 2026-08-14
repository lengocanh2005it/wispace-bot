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
  private static readonly DEFAULT_DRAIN_TIMEOUT_MS = 25_000;
  private static readonly IDLE_POLL_MS = 50;
  private readonly queues = new Map<string, QueueState<TContext>>();
  private readonly cleanupTimer: ReturnType<typeof setInterval>;
  private readonly maxPendingSize: number;
  private readonly drainTimeoutMs: number;
  private readonly callbacks: DebounceChatQueueCallbacks<TContext>;
  private shuttingDown = false;

  constructor(
    private readonly config: DebounceChatQueueConfig,
    private readonly onFlush: ChatQueueFlushHandler<TContext>,
    callbacks: DebounceChatQueueCallbacks<TContext> = {},
  ) {
    this.maxPendingSize =
      Number.isFinite(config.maxPendingSize) && (config.maxPendingSize ?? 0) > 0
        ? Math.floor(config.maxPendingSize as number)
        : DebounceChatQueue.DEFAULT_MAX_PENDING_SIZE;
    this.drainTimeoutMs =
      Number.isFinite(config.drainTimeoutMs) && (config.drainTimeoutMs ?? 0) > 0
        ? Math.floor(config.drainTimeoutMs as number)
        : DebounceChatQueue.DEFAULT_DRAIN_TIMEOUT_MS;
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

    if (this.shuttingDown) {
      // Shutdown already drains the queue — accepting more messages here
      // would silently drop them when the queue is cleared.
      this.callbacks.onShutdownRejected?.(input.externalUserId, text);
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
    // Each flush can promote pendingWhileProcessing texts, so keep draining
    // until no user has work left — but WAIT for active flushes instead of
    // skipping them (a flush in progress can still promote pending messages).
    const deadline = Date.now() + this.drainTimeoutMs;
    for (;;) {
      const users = [...this.queues.keys()];
      if (users.length === 0) {
        return;
      }
      await Promise.allSettled(users.map((user) => this.flushOrWait(user)));

      const hasWork = [...this.queues.values()].some(
        (state) =>
          state.processing ||
          state.texts.length > 0 ||
          state.pendingWhileProcessing.length > 0 ||
          state.debounceTimer != null,
      );
      if (!hasWork) {
        return;
      }
      if (Date.now() >= deadline) {
        return;
      }
    }
  }

  async destroy(): Promise<void> {
    if (this.shuttingDown) {
      // Idempotent — destroy may be triggered twice (module + process hooks).
      await this.drain();
      return;
    }
    this.shuttingDown = true;
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

  private async flushOrWait(externalUserId: string): Promise<void> {
    const state = this.queues.get(externalUserId);
    if (!state) {
      return;
    }
    if (state.processing) {
      // Wait for the active flush — its finally block promotes any
      // pendingWhileProcessing texts into `texts`, which the next flush
      // iteration then delivers.
      await new Promise<void>((resolve) => {
        const poll = () => {
          if (!state.processing) {
            resolve();
            return;
          }
          setTimeout(poll, DebounceChatQueue.IDLE_POLL_MS);
        };
        poll();
      });
    }
    await this.flush(externalUserId);
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
