import { Inject, Injectable, Logger } from '@nestjs/common';
import { errorMessage } from './error-message';
import { REDIS_CLIENT } from './redis.client.port';
import type { RedisClientPort } from './redis.client.port';

export interface RedisWebhookDedupeStoreOptions {
  /** Platform-scoped key prefix, e.g. 'messenger' — prevents cross-bot collisions on a shared Redis. */
  platform: string;
  /** TTL (seconds) for message-id keys. */
  midTtlSeconds: () => number;
  /** TTL (seconds) for postback keys. Optional — only Messenger uses postback dedupe. */
  postbackTtlSeconds?: () => number;
}

/**
 * Shared Redis webhook dedupe store. Keys are platform-scoped
 * (`dedupe:mid:{platform}:{id}`) so multiple bots sharing one Redis instance
 * never collide.
 *
 * Failure philosophy: fail-open with an in-process fallback. When Redis errors
 * mid-run we mark the key in a local map instead of dropping the event — a
 * lost user message is worse than a rare duplicate, and the per-platform
 * idempotency layer catches true duplicates. The fallback is per-instance
 * (single-pod dedupe) until Redis recovers.
 */
@Injectable()
export class RedisWebhookDedupeStore {
  private readonly logger = new Logger(RedisWebhookDedupeStore.name);
  private readonly fallbackSeen = new Map<string, number>();

  constructor(
    @Inject(REDIS_CLIENT)
    private readonly redisClient: RedisClientPort,
    private readonly options: RedisWebhookDedupeStoreOptions,
  ) {}

  isAvailable(): boolean {
    return (
      this.redisClient.isEnabled() &&
      this.redisClient.getNativeClient() !== null
    );
  }

  async isDuplicateMessageMid(mid: string): Promise<boolean> {
    return this.tryMarkKey(
      `dedupe:mid:${this.options.platform}:${mid}`,
      this.options.midTtlSeconds(),
    );
  }

  async isDuplicatePostback(psid: string, payload: string): Promise<boolean> {
    if (!this.options.postbackTtlSeconds) {
      return false;
    }
    return this.tryMarkKey(
      `dedupe:postback:${this.options.platform}:${psid}:${payload}`,
      this.options.postbackTtlSeconds(),
    );
  }

  private async tryMarkKey(key: string, ttlSeconds: number): Promise<boolean> {
    const client = this.redisClient.getNativeClient();
    if (!client) {
      return this.markInMemory(key, ttlSeconds);
    }

    try {
      const result = await client.set(key, '1', 'EX', ttlSeconds, 'NX');
      return result !== 'OK';
    } catch (error) {
      this.logger.warn(
        `Redis webhook dedupe failed key=${key}: ${errorMessage(error)} — falling back to in-memory dedupe`,
      );
      // Fail-open: dedupe in this process only; never drop the event.
      return this.markInMemory(key, ttlSeconds);
    }
  }

  private markInMemory(key: string, ttlSeconds: number): boolean {
    const now = Date.now();
    this.evictStaleFallback(now);
    const expiry = this.fallbackSeen.get(key);
    if (expiry !== undefined && expiry > now) {
      return true;
    }
    this.fallbackSeen.set(key, now + ttlSeconds * 1000);
    return false;
  }

  private evictStaleFallback(now: number): void {
    for (const [key, expiry] of this.fallbackSeen) {
      if (expiry <= now) {
        this.fallbackSeen.delete(key);
      }
    }
  }
}
