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
  listReadyExternalUserIds(limit: number): Promise<string[]>;
}
