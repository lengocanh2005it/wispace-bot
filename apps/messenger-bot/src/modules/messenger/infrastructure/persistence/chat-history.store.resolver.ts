import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  MemoryChatHistoryStore,
  RedisChatHistoryStore,
  type ChatHistoryMessage,
  type ChatHistoryStorePort,
  type RedisChatHistoryClient,
} from '@wispace/chat-history';
import { REDIS_CLIENT, type RedisClientPort } from '@wispace/bot-common';
import { MessengerChatSharedConfigService } from '../../application/services/messenger-chat-shared-config.service';

const KEY_PREFIX = 'chat:history:';

/**
 * Chat history store selector — wraps the shared @wispace/chat-history
 * stores with Messenger's env config (CHAT_HISTORY_*). Redis failures fall
 * back to empty/no-op instead of throwing (same resilience as before).
 */
@Injectable()
export class ChatHistoryStoreResolver implements ChatHistoryStorePort {
  private readonly logger = new Logger(ChatHistoryStoreResolver.name);
  private readonly memory: MemoryChatHistoryStore;
  private readonly redis?: RedisChatHistoryStore;

  constructor(
    private readonly sharedConfig: MessengerChatSharedConfigService,
    @Inject(REDIS_CLIENT)
    redisClient?: RedisClientPort | null,
  ) {
    const ttlMs = sharedConfig.getHistoryTtlMs();
    const maxMessages = sharedConfig.getHistoryMaxMessages();
    this.memory = new MemoryChatHistoryStore({ ttlMs, maxMessages });

    const nativeClient = redisClient?.getNativeClient();
    if (nativeClient) {
      this.redis = new RedisChatHistoryStore(
        nativeClient as unknown as RedisChatHistoryClient,
        {
          ttlSec: Math.max(1, Math.ceil(ttlMs / 1000)),
          maxMessages,
          keyPrefix: KEY_PREFIX,
        },
      );
    }
  }

  async getHistory(psid: string): Promise<ChatHistoryMessage[]> {
    return this.safe(() => this.resolveStore().getHistory(psid), []);
  }

  async appendTurn(
    psid: string,
    userText: string,
    assistantText: string,
  ): Promise<void> {
    await this.safe(
      () => this.resolveStore().appendTurn(psid, userText, assistantText),
      undefined,
    );
  }

  appendToolSummary(psid: string, summary: string): Promise<void> {
    return this.safe(async () => {
      await this.resolveStore().appendToolSummary?.(psid, summary);
    }, undefined);
  }

  async clear(psid: string): Promise<void> {
    await this.safe(() => this.resolveStore().clear(psid), undefined);
  }

  resolveStoreKind(): 'memory' | 'redis' {
    const configured = this.sharedConfig.getHistoryStore();
    if (configured === 'redis' && this.redis) {
      return 'redis';
    }
    return 'memory';
  }

  private resolveStore(): ChatHistoryStorePort {
    return this.resolveStoreKind() === 'redis' ? this.redis! : this.memory;
  }

  private async safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      this.logger.error(
        `Chat history store failed — falling back to ${
          this.resolveStoreKind() === 'redis' ? 'memory' : 'empty'
        }. Multi-pod history coherence lost. ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return fallback;
    }
  }
}
