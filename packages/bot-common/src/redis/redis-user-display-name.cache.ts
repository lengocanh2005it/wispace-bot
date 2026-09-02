import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { errorMessage } from '../masking/error-message';
import { maskExternalId } from '../masking/mask-external-id';
import { REDIS_CLIENT } from './redis.client.port';
import type { RedisClientPort } from './redis.client.port';

export interface CachedUserDisplayName {
  displayName: string | null;
  username?: string | null;
}

export interface RedisUserDisplayNameCacheOptions {
  /** Platform-scoped key prefix, e.g. 'messenger' — prevents cross-bot collisions on a shared Redis. */
  platform: string;
}

/**
 * Shared Redis user display-name cache. Keys are platform-scoped
 * (`cache:user:display:{platform}:{userId}`) so multiple bots sharing one
 * Redis instance never overwrite each other's entries for the same WISPACE
 * userId.
 */
@Injectable()
export class RedisUserDisplayNameCache {
  private readonly logger = new Logger(RedisUserDisplayNameCache.name);

  constructor(
    @Inject(REDIS_CLIENT)
    private readonly redisClient: RedisClientPort,
    private readonly configService: ConfigService,
    private readonly options: RedisUserDisplayNameCacheOptions,
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

  /** Messenger-style: read both displayName and username. */
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
        `Redis user display cache read failed userId=${maskExternalId(
          userId,
        )}: ${errorMessage(error)}`,
      );
      return null;
    }
  }

  /** Messenger-style: write both displayName and username. */
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
          username: value.username ?? null,
        }),
        'EX',
        this.ttlSeconds(),
      );
    } catch (error) {
      this.logger.warn(
        `Redis user display cache write failed userId=${maskExternalId(
          userId,
        )}: ${errorMessage(error)}`,
      );
    }
  }

  /** Discord/Zalo-style: read just the display name. */
  async getDisplayName(userId: number): Promise<string | null> {
    const cached = await this.get(userId);
    return cached?.displayName ?? null;
  }

  /** Discord/Zalo-style: write just the display name. */
  async setDisplayName(userId: number, displayName: string): Promise<void> {
    await this.set(userId, { displayName });
  }

  private key(userId: number): string {
    return `cache:user:display:${this.options.platform}:${userId}`;
  }

  async del(userId: number): Promise<void> {
    const client = this.redisClient.getNativeClient();
    if (!client || !this.isAvailable()) return;
    try {
      await client.del(this.key(userId));
    } catch (error) {
      this.logger.warn(
        `Redis user display cache delete failed userId=${maskExternalId(userId)}: ${errorMessage(error)}`,
      );
    }
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
