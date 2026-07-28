import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { REDIS_CLIENT } from '../../../../infrastructure/redis/redis.client.port';
import type { RedisClientPort } from '../../../../infrastructure/redis/redis.client.port';
import type {
  CachedUserDisplayName,
  UserDisplayNameCachePort,
} from '../../domain/repositories/user-display-name-cache.port';

@Injectable()
export class RedisUserDisplayNameCache implements UserDisplayNameCachePort {
  private static readonly KEY_PREFIX = 'cache:user:display:';

  private readonly logger = new Logger(RedisUserDisplayNameCache.name);

  constructor(
    @Inject(REDIS_CLIENT)
    private readonly redisClient: RedisClientPort,
    private readonly configService: ConfigService,
  ) {}

  isAvailable(): boolean {
    if (!this.isCacheEnabled()) {
      return false;
    }

    return (
      this.redisClient.isEnabled() &&
      this.redisClient.getNativeClient() !== null
    );
  }

  async get(userId: number): Promise<CachedUserDisplayName | null> {
    const client = this.redisClient.getNativeClient();
    if (!client || !this.isAvailable()) {
      return null;
    }

    try {
      const raw = await client.get(this.key(userId));
      if (!raw) {
        return null;
      }

      const parsed = JSON.parse(raw) as CachedUserDisplayName;
      return {
        displayName:
          typeof parsed.displayName === 'string' ? parsed.displayName : null,
        username: typeof parsed.username === 'string' ? parsed.username : null,
      };
    } catch (error) {
      this.logger.warn(
        `Redis user display cache read failed userId=${userId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  async set(userId: number, value: CachedUserDisplayName): Promise<void> {
    const client = this.redisClient.getNativeClient();
    if (!client || !this.isAvailable()) {
      return;
    }

    try {
      await client.set(
        this.key(userId),
        JSON.stringify({
          displayName: value.displayName,
          username: value.username,
        }),
        'EX',
        this.ttlSeconds(),
      );
    } catch (error) {
      this.logger.warn(
        `Redis user display cache write failed userId=${userId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private key(userId: number): string {
    return `${RedisUserDisplayNameCache.KEY_PREFIX}${userId}`;
  }

  private isCacheEnabled(): boolean {
    const raw = this.configService
      .get<string>('USER_DISPLAY_NAME_CACHE_ENABLED')
      ?.trim()
      .toLowerCase();

    if (!raw) {
      return true;
    }

    return raw === 'true' || raw === '1' || raw === 'yes';
  }

  private ttlSeconds(): number {
    const raw = this.configService
      .get<string>('USER_DISPLAY_NAME_CACHE_TTL_SECONDS')
      ?.trim();
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      return 3600;
    }

    return Math.floor(value);
  }
}
