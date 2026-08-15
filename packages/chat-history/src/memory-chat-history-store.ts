import type { ChatHistoryMessage } from './types';
import type { ChatHistoryStorePort } from './ports';

export interface MemoryChatHistoryStoreConfig {
  /** Idle-eviction window; a user with no turns for this long is dropped. */
  ttlMs: number;
  /** Max stored messages per user (2 per turn: user + assistant). */
  maxMessages: number;
  /** Global user cap — oldest-updated users are evicted beyond this (default 10_000). */
  maxUsers?: number;
  /** Pending tool summaries kept per user (default 10). */
  pendingSummariesPerUser?: number;
  /** Periodic sweep interval for expiry/cap enforcement (default 60s). */
  sweepMs?: number;
}

interface ChatHistoryState {
  messages: ChatHistoryMessage[];
  updatedAt: number;
}

interface PendingSummary {
  content: string;
  updatedAt: number;
}

/**
 * Plain in-memory chat history store — one process, not shared across pods.
 * Framework-agnostic core reused by every WISPACE bot; each app decides
 * whether to wrap it behind a distributed backend (e.g. Redis) via
 * `ChatHistoryStorePort`.
 *
 * Bounded by design: reads/writes only touch the single user (no full-map
 * scans), expiry and the global user cap are enforced by a periodic sweep
 * timer, and pending tool summaries are capped and expire with the TTL.
 * Call `dispose()` on shutdown to clear the timer and all state.
 */
export class MemoryChatHistoryStore implements ChatHistoryStorePort {
  private readonly store = new Map<string, ChatHistoryState>();
  /** Tool summaries visible via getHistory until the next appendTurn commits. */
  private readonly pendingSummaries = new Map<string, PendingSummary[]>();
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly config: MemoryChatHistoryStoreConfig) {
    this.timer = setInterval(() => this.evictStale(), this.sweepMs);
    this.timer.unref?.();
  }

  getHistory(externalUserId: string): Promise<ChatHistoryMessage[]> {
    const state = this.store.get(externalUserId);
    if (!state) {
      return Promise.resolve([]);
    }

    if (Date.now() - state.updatedAt > this.config.ttlMs) {
      this.store.delete(externalUserId);
      return Promise.resolve([]);
    }

    const summaries = (this.pendingSummaries.get(externalUserId) ?? [])
      .filter((summary) => Date.now() - summary.updatedAt <= this.config.ttlMs)
      .map((summary) => ({
        role: 'tool_summary' as const,
        content: summary.content,
      }));
    if (summaries.length === 0) {
      return Promise.resolve([...state.messages]);
    }
    return Promise.resolve([...state.messages, ...summaries]);
  }

  appendTurn(
    externalUserId: string,
    userText: string,
    assistantText: string,
  ): Promise<void> {
    const user = userText.trim();
    const assistant = assistantText.trim();
    if (!user || !assistant) {
      return Promise.resolve();
    }

    // Pending tool summaries were visible via getHistory(); drop them —
    // only the user/assistant turn is committed to the store. A stale
    // history is treated as empty (single-user lazy expiry).
    const state = this.store.get(externalUserId);
    const existing =
      state && Date.now() - state.updatedAt <= this.config.ttlMs
        ? state.messages
        : [];
    const messages = [
      ...existing,
      { role: 'user' as const, content: user },
      { role: 'assistant' as const, content: assistant },
    ].slice(-this.config.maxMessages);

    this.pendingSummaries.delete(externalUserId);
    this.store.set(externalUserId, {
      messages,
      updatedAt: Date.now(),
    });
    return Promise.resolve();
  }

  appendToolSummary(externalUserId: string, summary: string): Promise<void> {
    const list = this.pendingSummaries.get(externalUserId) ?? [];
    list.push({ content: summary, updatedAt: Date.now() });
    this.pendingSummaries.set(
      externalUserId,
      list.slice(-this.pendingSummariesPerUser),
    );
    return Promise.resolve();
  }

  clear(externalUserId: string): Promise<void> {
    this.pendingSummaries.delete(externalUserId);
    this.store.delete(externalUserId);
    return Promise.resolve();
  }

  /** Stop the sweep timer and release all state (idempotent). */
  dispose(): void {
    clearInterval(this.timer);
    this.store.clear();
    this.pendingSummaries.clear();
  }

  /**
   * Timer-driven maintenance only — never on the read/append hot path:
   * drop expired histories and summaries, then evict oldest-updated users
   * when the global cap is exceeded.
   */
  private evictStale(): void {
    const now = Date.now();

    for (const [externalUserId, state] of this.store) {
      if (now - state.updatedAt > this.config.ttlMs) {
        this.store.delete(externalUserId);
      }
    }

    for (const [externalUserId, summaries] of this.pendingSummaries) {
      const alive = summaries.filter(
        (summary) => now - summary.updatedAt <= this.config.ttlMs,
      );
      if (alive.length === 0) {
        this.pendingSummaries.delete(externalUserId);
      } else if (alive.length !== summaries.length) {
        this.pendingSummaries.set(externalUserId, alive);
      }
    }

    if (this.store.size > this.maxUsers) {
      const byAge = [...this.store.entries()].sort(
        ([, left], [, right]) => left.updatedAt - right.updatedAt,
      );
      for (const [externalUserId] of byAge) {
        if (this.store.size <= this.maxUsers) {
          break;
        }
        this.store.delete(externalUserId);
        // Cap eviction drops the user's pending summaries too — an evicted
        // user must not retain in-flight tool data until the TTL sweep.
        this.pendingSummaries.delete(externalUserId);
      }
    }
  }

  private get maxUsers(): number {
    return this.config.maxUsers ?? 10_000;
  }

  private get pendingSummariesPerUser(): number {
    return this.config.pendingSummariesPerUser ?? 10;
  }

  private get sweepMs(): number {
    return this.config.sweepMs ?? 60_000;
  }
}
