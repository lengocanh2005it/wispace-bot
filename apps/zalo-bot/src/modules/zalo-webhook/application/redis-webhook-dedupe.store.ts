import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { REDIS_CLIENT } from '@zalo/infrastructure/redis/redis.client.port';
import type { RedisClientPort } from '@zalo/infrastructure/redis/redis.client.port';

const MID_KEY_PREFIX = 'dedupe:mid:';

@Injectable()
export class RedisWebhookDedupeStore {
  private readonly logger = new Logger(RedisWebhookDedupeStore.name);

  constructor(
    @Inject(REDIS_CLIENT)
    private readonly redisClient: RedisClientPort,
    private readonly configService: ConfigService,
  ) {}

  isAvailable(): boolean {
    return (
      this.redisClient.isEnabled() &&
      this.redisClient.getNativeClient() !== null
    );
  }

  async isDuplicate(msgId: string): Promise<boolean> {
    const client = this.redisClient.getNativeClient();
    if (!client) return false;
    const ttl = Math.max(
      1,
      this.configService.get<number>('ZALO_WEBHOOK_DEDUPE_TTL_SECONDS') ?? 60,
    );
    try {
      const result = await client.set(
        `${MID_KEY_PREFIX}${msgId}`,
        '1',
        'EX',
        ttl,
        'NX',
      );
      return result !== 'OK';
    } catch (error) {
      this.logger.warn(
        `Redis dedupe failed for msgId=${msgId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }
}
