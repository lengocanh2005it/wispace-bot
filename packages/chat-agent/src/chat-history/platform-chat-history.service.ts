import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MemoryChatHistoryStore,
  RedisChatHistoryStore,
  type ChatHistoryMessage,
  type ChatHistoryStorePort,
  type RedisChatHistoryClient,
} from '@wispace/chat-history';
import type { PlatformChatHistoryOptions } from '../agent/platform-agent.types';

const DEFAULT_MAX_MESSAGES = 20; // 10 turns (user + assistant)
const DEFAULT_TTL_MS = 30 * 60 * 1000;

/**
 * Chat history for a platform — supports memory (default) or Redis backend.
 * Env keys and Redis key prefix are parameterized per app (Discord:
 * CHAT_HISTORY_* / chat-history:discord:; Zalo: ZALO_CHAT_HISTORY_* /
 * chat-history:zalo:).
 */
@Injectable()
export class PlatformChatHistoryService {
  private readonly logger = new Logger(PlatformChatHistoryService.name);
  private readonly store: ChatHistoryStorePort;

  constructor(
    configService: ConfigService,
    options: PlatformChatHistoryOptions,
    redisClient?: { getNativeClient(): unknown } | null,
  ) {
    const ttlMs =
      Number(configService.get<string>(`${options.envPrefix}TTL_MS`)) ||
      DEFAULT_TTL_MS;
    const maxMessages =
      Number(configService.get<string>(`${options.envPrefix}MAX_MESSAGES`)) ||
      DEFAULT_MAX_MESSAGES;

    const storeType =
      configService.get<string>('CHAT_HISTORY_STORE')?.trim() ?? 'memory';

    const nativeClient = redisClient?.getNativeClient() ?? null;

    if (storeType === 'redis' && nativeClient) {
      this.store = new RedisChatHistoryStore(
        nativeClient as unknown as RedisChatHistoryClient,
        {
          ttlSec: Math.floor(ttlMs / 1000),
          maxMessages,
          keyPrefix: options.keyPrefix,
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

  getHistory(externalUserId: string): Promise<ChatHistoryMessage[]> {
    return this.store.getHistory(externalUserId);
  }

  appendTurn(
    externalUserId: string,
    userText: string,
    assistantText: string,
  ): Promise<void> {
    return this.store.appendTurn(externalUserId, userText, assistantText);
  }
}
