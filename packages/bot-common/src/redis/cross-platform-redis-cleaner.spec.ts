import { CrossPlatformRedisCleaner } from './cross-platform-redis-cleaner';
import type { RedisClientPort } from './redis.client.port';

function makeRedisClient(delFn?: jest.Mock) {
  const del = delFn ?? jest.fn().mockResolvedValue(1);
  return {
    isEnabled: jest.fn().mockReturnValue(true),
    isConfiguredEnabled: jest.fn().mockReturnValue(true),
    ping: jest.fn().mockResolvedValue('PONG'),
    getNativeClient: jest.fn().mockReturnValue({ del }),
  } satisfies jest.Mocked<RedisClientPort>;
}

describe('CrossPlatformRedisCleaner', () => {
  it.each(['messenger', 'discord', 'zalo'] as const)(
    'deletes correct per-platform keys for %s',
    async (platform) => {
      const del = jest.fn().mockResolvedValue(3);
      const client = makeRedisClient(del);
      const cleaner = new CrossPlatformRedisCleaner(client, platform);

      await cleaner.clean('user-42');

      expect(del).toHaveBeenCalledTimes(1);
      const keys = del.mock.calls[0] as string[];

      // History key matches platform prefix
      if (platform === 'messenger') {
        expect(keys).toContain('chat:history:user-42');
      } else {
        expect(keys).toContain(`chat-history:${platform}:user-42`);
      }

      // Buffer key matches platform prefix
      if (platform === 'messenger') {
        expect(keys).toContain('chat:queue:buffer:user-42');
      } else {
        expect(keys).toContain(`chat:queue:${platform}:buffer:user-42`);
      }

      // Does NOT contain other platforms' history
      const otherPlatforms = ['messenger', 'discord', 'zalo'].filter(
        (p) => p !== platform,
      );
      for (const other of otherPlatforms) {
        expect(keys).not.toContain(`chat-history:${other}:user-42`);
      }
    },
  );

  it('no-ops when Redis is not available', async () => {
    const client = makeRedisClient();
    client.getNativeClient.mockReturnValue(null);
    const cleaner = new CrossPlatformRedisCleaner(client, 'messenger');

    await cleaner.clean('user-42');

    // Should not throw, no DEL calls
    expect(client.getNativeClient).toHaveBeenCalled();
  });

  it('swallows Redis errors', async () => {
    const del = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const client = makeRedisClient(del);
    const cleaner = new CrossPlatformRedisCleaner(client, 'discord');

    await expect(cleaner.clean('user-42')).resolves.not.toThrow();
  });
});
