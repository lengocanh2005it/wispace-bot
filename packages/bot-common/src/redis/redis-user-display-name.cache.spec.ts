import { ConfigService } from '@nestjs/config';
import type { RedisClientPort } from './redis.client.port';
import { RedisUserDisplayNameCache } from './redis-user-display-name.cache';

describe('RedisUserDisplayNameCache', () => {
  it('keeps normal deletion best-effort but exposes privacy failures', async () => {
    const del = jest.fn().mockRejectedValue(new Error('redis down'));
    const cache = new RedisUserDisplayNameCache(
      {
        isEnabled: () => true,
        isConfiguredEnabled: () => true,
        ping: async () => 'PONG',
        getNativeClient: () =>
          ({ del }) as unknown as ReturnType<
            RedisClientPort['getNativeClient']
          >,
      },
      new ConfigService(),
      { platform: 'messenger' },
    );

    await expect(cache.del(42)).resolves.toBeUndefined();
    await expect(cache.delStrict(42)).rejects.toThrow('redis down');
    expect(del).toHaveBeenCalledTimes(2);
  });

  it('fails strict deletion when the Redis client is unavailable', async () => {
    const cache = new RedisUserDisplayNameCache(
      {
        isEnabled: () => false,
        isConfiguredEnabled: () => true,
        ping: async () => 'PONG',
        getNativeClient: () => null,
      },
      new ConfigService(),
      { platform: 'messenger' },
    );

    await expect(cache.delStrict(42)).rejects.toThrow(
      'Redis user display cache unavailable',
    );
  });
});
