import type { ChatHistoryMessage } from './types';
import type { ChatHistoryStorePort } from './ports';

export interface MemoryChatHistoryStoreConfig {
  /** Idle-eviction window; a user with no turns for this long is dropped. */
  ttlMs: number;
  /** Max stored messages per user (2 per turn: user + assistant). */
  maxMessages: number;
}

interface ChatHistoryState {
  messages: ChatHistoryMessage[];
  updatedAt: number;
}

/**
 * Plain in-memory chat history store — one process, not shared across pods.
 * Framework-agnostic core reused by every WISPACE bot; each app decides
 * whether to wrap it behind a distributed backend (e.g. Redis) via
 * `ChatHistoryStorePort`.
 */
export class MemoryChatHistoryStore implements ChatHistoryStorePort {
  private readonly store = new Map<string, ChatHistoryState>();
  /** Tool summaries visible via getHistory until the next appendTurn commits. */
  private readonly pendingSummaries = new Map<string, string[]>();

  constructor(private readonly config: MemoryChatHistoryStoreConfig) {}

  getHistory(externalUserId: string): Promise<ChatHistoryMessage[]> {
    this.evictStale();

    const state = this.store.get(externalUserId);
    if (!state) {
      return Promise.resolve([]);
    }

    if (Date.now() - state.updatedAt > this.config.ttlMs) {
      this.store.delete(externalUserId);
      return Promise.resolve([]);
    }

    const summaries = this.pendingSummaries.get(externalUserId) ?? [];
    if (summaries.length === 0) {
      return Promise.resolve([...state.messages]);
    }
    return Promise.resolve([
      ...state.messages,
      ...summaries.map((content) => ({
        role: 'tool_summary' as const,
        content,
      })),
    ]);
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

    this.evictStale();

    // Pending tool summaries were visible via getHistory(); drop them —
    // only the user/assistant turn is committed to the store.
    const state = this.store.get(externalUserId);
    const existing = state ? state.messages : [];
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
    list.push(summary);
    this.pendingSummaries.set(externalUserId, list);
    return Promise.resolve();
  }

  clear(externalUserId: string): Promise<void> {
    this.pendingSummaries.delete(externalUserId);
    this.store.delete(externalUserId);
    return Promise.resolve();
  }

  private evictStale(): void {
    const now = Date.now();

    for (const [externalUserId, state] of this.store) {
      if (now - state.updatedAt > this.config.ttlMs) {
        this.store.delete(externalUserId);
      }
    }
  }
}
