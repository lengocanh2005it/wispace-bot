import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { REDIS_CLIENT } from '../../infrastructure/redis/redis.client.port';
import type { RedisClientPort } from '../../infrastructure/redis/redis.client.port';
import type { DisplayNameCachePort } from '@wispace/study-reminder-shared';

@Injectable()
export class ZaloRedisUserDisplayNameCache implements DisplayNameCachePort {
  private static readonly KEY_PREFIX = 'cache:user:display:';
  private readonly logger = new Logger(ZaloRedisUserDisplayNameCache.name);

  constructor(
    @Inject(REDIS_CLIENT)
    private readonly redisClient: RedisClientPort,
    private readonly configService: ConfigService,
  ) {}

  private isAvailable(): boolean {
    return (
      this.redisClient.isEnabled() &&
      this.redisClient.getNativeClient() !== null
    );
  }

  async getDisplayName(userId: number): Promise<string | null> {
    const client = this.redisClient.getNativeClient();
    if (!client || !this.isAvailable()) return null;

    try {
      const raw = await client.get(
        `${ZaloRedisUserDisplayNameCache.KEY_PREFIX}${userId}`,
      );
      if (!raw) return null;
      const parsed: { displayName?: string } = JSON.parse(raw) as {
        displayName?: string;
      };
      return parsed.displayName ?? null;
    } catch (error) {
      this.logger.warn(
        `Redis display name cache read failed userId=${userId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  async setDisplayName(userId: number, displayName: string): Promise<void> {
    const client = this.redisClient.getNativeClient();
    if (!client || !this.isAvailable()) return;

    try {
      await client.set(
        `${ZaloRedisUserDisplayNameCache.KEY_PREFIX}${userId}`,
        JSON.stringify({ displayName }),
        'EX',
        this.ttlSeconds(),
      );
    } catch (error) {
      this.logger.warn(
        `Redis display name cache write failed userId=${userId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private ttlSeconds(): number {
    const raw = this.configService
      .get<string>('USER_DISPLAY_NAME_CACHE_TTL_SECONDS')
      ?.trim();
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 3600;
  }
}
