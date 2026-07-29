import { Inject, Injectable, Logger } from '@nestjs/common';
import { REDIS_CLIENT } from '@messenger/infrastructure/redis/redis.client.port';
import type { RedisClientPort } from '@messenger/infrastructure/redis/redis.client.port';
import { WEBHOOK_POSTBACK_DEDUPE_MS } from '../../domain/entities/messenger-store.types';
import type { WebhookDedupeStorePort } from '../../domain/repositories/webhook-dedupe.store.port';
import { MessengerChatSharedConfigService } from '../../application/services/messenger-chat-shared-config.service';

@Injectable()
export class RedisWebhookDedupeStore implements WebhookDedupeStorePort {
  private static readonly MID_KEY_PREFIX = 'dedupe:mid:';
  private static readonly POSTBACK_KEY_PREFIX = 'dedupe:postback:';

  private readonly logger = new Logger(RedisWebhookDedupeStore.name);

  constructor(
    @Inject(REDIS_CLIENT)
    private readonly redisClient: RedisClientPort,
    private readonly sharedConfig: MessengerChatSharedConfigService,
  ) {}

  isAvailable(): boolean {
    return (
      this.redisClient.isEnabled() &&
      this.redisClient.getNativeClient() !== null
    );
  }

  async isDuplicateMessageMid(mid: string, psid: string): Promise<boolean> {
    void psid;
    return this.tryMarkKey(
      `${RedisWebhookDedupeStore.MID_KEY_PREFIX}${mid}`,
      this.midTtlSeconds(),
    );
  }

  async isDuplicatePostback(psid: string, payload: string): Promise<boolean> {
    return this.tryMarkKey(
      `${RedisWebhookDedupeStore.POSTBACK_KEY_PREFIX}${psid}:${payload}`,
      Math.max(1, Math.ceil(WEBHOOK_POSTBACK_DEDUPE_MS / 1000)),
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

  private midTtlSeconds(): number {
    return Math.max(
      1,
      Math.ceil(this.sharedConfig.getWebhookDedupeRetentionMs() / 1000),
    );
  }
}
