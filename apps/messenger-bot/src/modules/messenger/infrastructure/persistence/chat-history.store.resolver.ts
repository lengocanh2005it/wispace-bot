import { Injectable } from '@nestjs/common';
import type { ChatHistoryMessage } from '../../domain/entities/messenger-store.types';
import type { ChatHistoryStorePort } from '../../domain/repositories/chat-history.store.port';
import { MessengerChatSharedConfigService } from '../../application/services/messenger-chat-shared-config.service';
import { MemoryChatHistoryStore } from './memory-chat-history.store';
import { RedisChatHistoryStore } from './redis-chat-history.store';

@Injectable()
export class ChatHistoryStoreResolver implements ChatHistoryStorePort {
  constructor(
    private readonly sharedConfig: MessengerChatSharedConfigService,
    private readonly memoryStore: MemoryChatHistoryStore,
    private readonly redisStore: RedisChatHistoryStore,
  ) {}

  getHistory(psid: string): Promise<ChatHistoryMessage[]> {
    return this.resolveStore().getHistory(psid);
  }

  appendTurn(
    psid: string,
    userText: string,
    assistantText: string,
  ): Promise<void> {
    return this.resolveStore().appendTurn(psid, userText, assistantText);
  }

  appendToolSummary(psid: string, summary: string): Promise<void> {
    return this.resolveStore().appendToolSummary(psid, summary);
  }

  clear(psid: string): Promise<void> {
    return this.resolveStore().clear(psid);
  }

  resolveStoreKind(): 'memory' | 'redis' {
    const configured = this.sharedConfig.getHistoryStore();

    if (configured === 'redis' && this.redisStore.isAvailable()) {
      return 'redis';
    }

    return 'memory';
  }

  private resolveStore(): ChatHistoryStorePort {
    return this.resolveStoreKind() === 'redis'
      ? this.redisStore
      : this.memoryStore;
  }
}
