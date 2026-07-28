import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { REDIS_CLIENT } from '../../infrastructure/redis/redis.module';
import type { DisplayNameCachePort } from '@wispace/study-reminder-shared';
import type Redis from 'ioredis';

@Injectable()
export class DiscordRedisUserDisplayNameCache implements DisplayNameCachePort {
  private static readonly KEY_PREFIX = 'cache:user:display:';
  private readonly logger = new Logger(DiscordRedisUserDisplayNameCache.name);

  constructor(
    @Inject(REDIS_CLIENT)
    private readonly redis: Redis | null,
    private readonly configService: ConfigService,
  ) {}

  private isAvailable(): boolean {
    return this.redis !== null;
  }

  async getDisplayName(userId: number): Promise<string | null> {
    if (!this.isAvailable()) return null;
    try {
      const raw = await this.redis!.get(
        `${DiscordRedisUserDisplayNameCache.KEY_PREFIX}${userId}`,
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
    if (!this.isAvailable()) return;
    try {
      await this.redis!.set(
        `${DiscordRedisUserDisplayNameCache.KEY_PREFIX}${userId}`,
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
