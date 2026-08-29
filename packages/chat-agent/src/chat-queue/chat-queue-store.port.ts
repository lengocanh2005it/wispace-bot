import type {
  AppendChatBufferInput,
  ChatQueueBufferSnapshot,
  CompleteChatBufferInput,
} from './chat-queue-store.types';

export const PLATFORM_CHAT_QUEUE_STORE = Symbol('PLATFORM_CHAT_QUEUE_STORE');

export interface ChatQueueStorePort {
  isAvailable(): boolean;
  appendChatBuffer(input: AppendChatBufferInput): Promise<void>;
  claimReadyBuffer(
    externalUserId: string,
    debounceMs: number,
    processingStuckMs: number,
  ): Promise<ChatQueueBufferSnapshot | null>;
  completeChatBuffer(input: CompleteChatBufferInput): Promise<boolean>;
  /** Removes queued (including in-flight) work for a privacy/link invalidation. */
  clearChatBuffer?(externalUserId: string): Promise<boolean>;
  listReadyExternalUserIds(limit: number): Promise<string[]>;
  /**
   * Re-enqueue the currently processing batch for a delayed retry (#406).
   * Moves processingTexts (+ pendingTexts) back to texts and sets flushAfterAt
   * so the next worker poll picks it up after the delay. Requires the current
   * lease token; stale workers are no-ops.
   */
  scheduleRetryFlush(
    externalUserId: string,
    retryDelayMs: number,
    leaseToken: string,
  ): Promise<boolean>;
}
