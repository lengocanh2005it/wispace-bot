import { ConfigService } from '@nestjs/config';
import type { RedisClientPort } from '@messenger/infrastructure/redis/redis.client.port';
import { RedisUserDisplayNameCache } from './redis-user-display-name.cache';

describe('RedisUserDisplayNameCache', () => {
  const redisMock = {
    get: jest.fn(),
    set: jest.fn(),
  };

  const redisClient: RedisClientPort = {
    isEnabled: () => true,
    ping: jest.fn(),
    getNativeClient: () => redisMock as never,
  };

  const config = {
    get: jest.fn((key: string) => {
      if (key === 'USER_DISPLAY_NAME_CACHE_TTL_SECONDS') {
        return '120';
      }

      return undefined;
    }),
  } as unknown as ConfigService;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reads cached display name', async () => {
    redisMock.get.mockResolvedValue(
      JSON.stringify({ displayName: 'Lan', username: 'lan01' }),
    );

    const cache = new RedisUserDisplayNameCache(redisClient, config);
    await expect(cache.get(42)).resolves.toEqual({
      displayName: 'Lan',
      username: 'lan01',
    });
  });

  it('writes cache with ttl', async () => {
    const cache = new RedisUserDisplayNameCache(redisClient, config);
    await cache.set(42, { displayName: 'Lan', username: null });

    expect(redisMock.set).toHaveBeenCalledWith(
      'cache:user:display:42',
      JSON.stringify({ displayName: 'Lan', username: null }),
      'EX',
      120,
    );
  });

  it('is unavailable when redis disabled', () => {
    const disabledClient: RedisClientPort = {
      isEnabled: () => false,
      ping: jest.fn(),
      getNativeClient: () => null,
    };

    const cache = new RedisUserDisplayNameCache(disabledClient, config);
    expect(cache.isAvailable()).toBe(false);
  });
});
