import { Injectable } from '@nestjs/common';
import type { WebhookDedupeStorePort } from '../../domain/repositories/webhook-dedupe.store.port';
import { MessengerChatSharedConfigService } from '../../application/services/messenger-chat-shared-config.service';
import { MemoryWebhookDedupeStore } from './memory-webhook-dedupe.store';
import type { RedisWebhookDedupeStore } from '@wispace/bot-common';

@Injectable()
export class WebhookDedupeStoreResolver implements WebhookDedupeStorePort {
  constructor(
    private readonly sharedConfig: MessengerChatSharedConfigService,
    private readonly memoryStore: MemoryWebhookDedupeStore,
    private readonly redisStore: RedisWebhookDedupeStore,
  ) {}

  isDuplicateMessageMid(mid: string, _psid: string): Promise<boolean> {
    return this.resolveStore().isDuplicateMessageMid(mid, _psid);
  }

  isDuplicatePostback(psid: string, payload: string): Promise<boolean> {
    return this.resolveStore().isDuplicatePostback(psid, payload);
  }

  resolveStoreKind(): 'memory' | 'redis' {
    const configured = this.sharedConfig.getDedupeStore();

    if (configured === 'redis' && this.redisStore.isAvailable()) {
      return 'redis';
    }

    return 'memory';
  }

  private resolveStore(): WebhookDedupeStorePort {
    return this.resolveStoreKind() === 'redis'
      ? this.redisStore
      : this.memoryStore;
  }
}
