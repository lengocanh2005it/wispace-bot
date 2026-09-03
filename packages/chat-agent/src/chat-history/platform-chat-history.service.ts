import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MemoryChatHistoryStore,
  MemoryCompactionCache,
  RedisChatHistoryStore,
  RedisCompactionCache,
  type ChatHistoryMessage,
  type ChatHistoryStorePort,
  type CompactionCachePort,
  type RedisChatHistoryClient,
} from '@wispace/chat-history';
import type { PlatformChatHistoryOptions } from '../agent/platform-agent.types';

const DEFAULT_MAX_MESSAGES = 20; // 10 turns (user + assistant)
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_USERS = 10_000;
/** How long to wait for RedisService's async connect (ping) before failing closed. */
const REDIS_AVAILABILITY_WAIT_MS = 5_000;
const REDIS_AVAILABILITY_POLL_MS = 50;

/**
 * Chat history for a platform — supports memory (default) or Redis backend.
 * Env keys and Redis key prefix are parameterized per app (Discord:
 * CHAT_HISTORY_* / chat-history:discord:; Zalo: ZALO_CHAT_HISTORY_* /
 * chat-history:zalo:).
 */
@Injectable()
export class PlatformChatHistoryService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PlatformChatHistoryService.name);
  private readonly memory: MemoryChatHistoryStore;
  /** #704 — persisted compaction summaries, same backend + TTL as history. */
  private readonly compactionMemory: MemoryCompactionCache;
  private readonly storeType: string;
  private readonly ttlMs: number;
  private readonly maxMessages: number;
  private readonly options: PlatformChatHistoryOptions;
  private readonly redisClient?: { getNativeClient(): unknown } | null;
  private redis?: RedisChatHistoryStore;
  private redisCompaction?: RedisCompactionCache;

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
    const maxUsers =
      Number(configService.get<string>(`${options.envPrefix}MAX_USERS`)) ||
      DEFAULT_MAX_USERS;

    this.storeType =
      configService.get<string>('CHAT_HISTORY_STORE')?.trim() ?? 'memory';
    this.ttlMs = ttlMs;
    this.maxMessages = maxMessages;
    this.options = options;
    this.redisClient = redisClient;
    this.memory = new MemoryChatHistoryStore({ ttlMs, maxMessages, maxUsers });
    this.compactionMemory = new MemoryCompactionCache({ ttlMs, maxUsers });
  }

  onModuleDestroy(): void {
    this.memory.dispose();
    this.compactionMemory.dispose();
  }

  async onModuleInit(): Promise<void> {
    // Fail closed: Redis history is the multi-pod coherence contract — never
    // silently downgrade to per-process memory. The check runs AFTER
    // RedisService's async connect (ping) has had a chance to finish —
    // checking in the constructor races with it and crashes legitimate boots.
    if (this.storeType !== 'redis') {
      return;
    }
    if (!this.redisClient?.getNativeClient()) {
      await this.waitForRedisClient();
    }
    if (!this.redisClient?.getNativeClient()) {
      throw new Error(
        'CHAT_HISTORY_STORE=redis but Redis client is unavailable — refusing to silently fall back to memory. Enable Redis or set CHAT_HISTORY_STORE=memory.',
      );
    }
  }

  private async waitForRedisClient(): Promise<void> {
    const deadline = Date.now() + REDIS_AVAILABILITY_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) =>
        setTimeout(resolve, REDIS_AVAILABILITY_POLL_MS),
      );
      if (this.redisClient?.getNativeClient()) {
        return;
      }
    }
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

  appendToolSummary(externalUserId: string, summary: string): Promise<void> {
    const store = this.resolveStore();
    if (store.appendToolSummary) {
      return store.appendToolSummary(externalUserId, summary);
    }
    return Promise.resolve();
  }

  /** Clears retained turns when ownership is revoked or cannot be verified. */
  async clear(externalUserId: string): Promise<void> {
    // #704 — the compaction summary is derived history state: a surviving
    // summary after erasure is a privacy bug, so both clears are always
    // attempted even if the first fails, and no caller has to remember a
    // second key.
    const results = await Promise.allSettled([
      this.resolveStore().clear(externalUserId),
      this.resolveCompactionCache().clear(externalUserId),
    ]);
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
    }
  }

  /**
   * #704 — persisted compaction-summary cache for the LLM agent, sharing this
   * service's backend, TTL and platform key scope.
   */
  getCompactionCache(): CompactionCachePort {
    return this.resolveCompactionCache();
  }

  private resolveStore(): ChatHistoryStorePort {
    if (this.storeType !== 'redis') {
      return this.memory;
    }

    if (this.redis) {
      return this.redis;
    }

    const nativeClient = this.redisClient!.getNativeClient();
    this.redis = new RedisChatHistoryStore(
      nativeClient as RedisChatHistoryClient,
      {
        ttlSec: Math.floor(this.ttlMs / 1000),
        maxMessages: this.maxMessages,
        keyPrefix: this.options.keyPrefix,
      },
    );
    this.logger.log('Chat history: Redis backend');
    return this.redis;
  }

  private resolveCompactionCache(): CompactionCachePort {
    if (this.storeType !== 'redis') {
      return this.compactionMemory;
    }

    if (this.redisCompaction) {
      return this.redisCompaction;
    }

    const nativeClient = this.redisClient!.getNativeClient();
    this.redisCompaction = new RedisCompactionCache(
      nativeClient as RedisChatHistoryClient,
      {
        ttlSec: Math.floor(this.ttlMs / 1000),
        keyPrefix: this.options.keyPrefix,
      },
    );
    return this.redisCompaction;
  }
}
