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
  private readonly memory: MemoryChatHistoryStore;
  private readonly storeType: string;
  private readonly ttlMs: number;
  private readonly maxMessages: number;
  private readonly options: PlatformChatHistoryOptions;
  private readonly redisClient?: { getNativeClient(): unknown } | null;
  private redis?: RedisChatHistoryStore;
  private redisUnavailableLogged = false;

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

    this.storeType =
      configService.get<string>('CHAT_HISTORY_STORE')?.trim() ?? 'memory';
    this.ttlMs = ttlMs;
    this.maxMessages = maxMessages;
    this.options = options;
    this.redisClient = redisClient;
    this.memory = new MemoryChatHistoryStore({ ttlMs, maxMessages });
  }

  getHistory(externalUserId: string): Promise<ChatHistoryMessage[]> {
    return this.resolveStore().getHistory(externalUserId);
  }

  appendTurn(
    externalUserId: string,
    userText: string,
    assistantText: string,
  ): Promise<void> {
    return this.resolveStore().appendTurn(
      externalUserId,
      userText,
      assistantText,
    );
  }

  private resolveStore(): ChatHistoryStorePort {
    if (this.storeType !== 'redis') {
      return this.memory;
    }

    if (this.redis) {
      return this.redis;
    }

    const nativeClient = this.redisClient?.getNativeClient() ?? null;
    if (!nativeClient) {
      if (!this.redisUnavailableLogged) {
        this.redisUnavailableLogged = true;
        this.logger.warn(
          'CHAT_HISTORY_STORE=redis but Redis unavailable — falling back to memory',
        );
      }
      return this.memory;
    }

    this.redis = new RedisChatHistoryStore(
      nativeClient as unknown as RedisChatHistoryClient,
      {
        ttlSec: Math.floor(this.ttlMs / 1000),
        maxMessages: this.maxMessages,
        keyPrefix: this.options.keyPrefix,
      },
    );
    this.logger.log('Chat history: Redis backend');
    return this.redis;
  }
}
