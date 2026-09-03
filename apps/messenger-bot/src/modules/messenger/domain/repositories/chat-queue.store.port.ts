import type {
  AppendChatBufferInput,
  ChatQueueBufferSnapshot,
  CompleteChatBufferInput,
} from '../entities/chat-shared-state.types';
import type { ChatQueueReconciliationResult } from '@wispace/chat-agent';

export const CHAT_QUEUE_STORE = Symbol('CHAT_QUEUE_STORE');

export interface ChatQueueStorePort {
  appendChatBuffer(input: AppendChatBufferInput): Promise<void>;
  claimReadyBuffer(
    psid: string,
    debounceMs: number,
    processingStuckMs: number,
  ): Promise<ChatQueueBufferSnapshot | null>;
  completeChatBuffer(input: CompleteChatBufferInput): Promise<boolean>;
  clearChatBuffer?(psid: string): Promise<boolean>;
  listPsidsReadyForFlush(limit: number): Promise<string[]>;
  reconcile?(): Promise<ChatQueueReconciliationResult>;
  scheduleRetryFlush(
    psid: string,
    retryDelayMs: number,
    leaseToken: string,
  ): Promise<boolean>;
}
