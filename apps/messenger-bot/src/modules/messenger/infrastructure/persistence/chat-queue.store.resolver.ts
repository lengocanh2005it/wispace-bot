import { Injectable } from '@nestjs/common';
import type {
  AppendChatBufferInput,
  ChatQueueBufferSnapshot,
  CompleteChatBufferInput,
} from '../../domain/entities/chat-shared-state.types';
import type { ChatQueueStorePort } from '../../domain/repositories/chat-queue.store.port';
import { MessengerChatSharedConfigService } from '../../application/services/messenger-chat-shared-config.service';
import { RedisChatQueueStore } from './redis-chat-queue.store';

@Injectable()
export class ChatQueueStoreResolver implements ChatQueueStorePort {
  constructor(
    private readonly sharedConfig: MessengerChatSharedConfigService,
    private readonly redisStore: RedisChatQueueStore,
  ) {}

  appendChatBuffer(input: AppendChatBufferInput): Promise<void> {
    return this.redisStore.appendChatBuffer(input);
  }

  claimReadyBuffer(
    psid: string,
    debounceMs: number,
    processingStuckMs: number,
  ): Promise<ChatQueueBufferSnapshot | null> {
    return this.redisStore.claimReadyBuffer(
      psid,
      debounceMs,
      processingStuckMs,
    );
  }

  completeChatBuffer(input: CompleteChatBufferInput): Promise<boolean> {
    return this.redisStore.completeChatBuffer(input);
  }

  listPsidsReadyForFlush(
    limit: number,
    processingStuckMs: number,
  ): Promise<string[]> {
    return this.redisStore.listPsidsReadyForFlush(limit, processingStuckMs);
  }

  resolveStoreKind(): 'redis' {
    return 'redis';
  }
}
