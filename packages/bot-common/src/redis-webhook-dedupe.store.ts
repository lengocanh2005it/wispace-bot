import { Inject, Injectable, Logger } from '@nestjs/common';
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
 */
@Injectable()
export class RedisWebhookDedupeStore {
  private readonly logger = new Logger(RedisWebhookDedupeStore.name);

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
      return false;
    }

    try {
      const result = await client.set(key, '1', 'EX', ttlSeconds, 'NX');
      return result !== 'OK';
    } catch (error) {
      this.logger.warn(
        `Redis webhook dedupe failed key=${key}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }
}
