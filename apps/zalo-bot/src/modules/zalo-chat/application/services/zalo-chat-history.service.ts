import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MemoryChatHistoryStore,
  RedisChatHistoryStore,
  type ChatHistoryMessage,
  type ChatHistoryStorePort,
  type RedisChatHistoryClient,
} from '@wispace/chat-history';
import { REDIS_CLIENT } from '@zalo/infrastructure/redis/redis.client.port';
import type Redis from 'ioredis';

const DEFAULT_MAX_MESSAGES = 20;
const DEFAULT_TTL_MS = 30 * 60 * 1000;

/**
 * Chat history for Zalo — supports memory (default) or Redis backend.
 * Set CHAT_HISTORY_STORE=redis + REDIS_ENABLED=true for multi-pod mode.
 */
@Injectable()
export class ZaloChatHistoryService {
  private readonly logger = new Logger(ZaloChatHistoryService.name);
  private readonly store: ChatHistoryStorePort;

  constructor(
    configService: ConfigService,
    @Optional() @Inject(REDIS_CLIENT) redisClient?: Redis | null,
  ) {
    const ttlMs =
      Number(configService.get<string>('ZALO_CHAT_HISTORY_TTL_MS')) ||
      DEFAULT_TTL_MS;
    const maxMessages =
      Number(configService.get<string>('ZALO_CHAT_HISTORY_MAX_MESSAGES')) ||
      DEFAULT_MAX_MESSAGES;

    const storeType =
      configService.get<string>('CHAT_HISTORY_STORE')?.trim() ?? 'memory';

    if (storeType === 'redis' && redisClient) {
      this.store = new RedisChatHistoryStore(
        redisClient as unknown as RedisChatHistoryClient,
        {
          ttlSec: Math.floor(ttlMs / 1000),
          maxMessages,
        },
      );
      this.logger.log('Chat history: Redis backend');
    } else {
      this.store = new MemoryChatHistoryStore({ ttlMs, maxMessages });
      if (storeType === 'redis') {
        this.logger.warn(
          'CHAT_HISTORY_STORE=redis but Redis unavailable — falling back to memory',
        );
      }
    }
  }

  getHistory(zaloUserId: string): Promise<ChatHistoryMessage[]> {
    return this.store.getHistory(zaloUserId);
  }

  appendTurn(
    zaloUserId: string,
    userText: string,
    assistantText: string,
  ): Promise<void> {
    return this.store.appendTurn(zaloUserId, userText, assistantText);
  }
}
