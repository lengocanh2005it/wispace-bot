import type Redis from 'ioredis';
import { RedisThrottlerStorage } from './redis-throttler-storage';
import type { RedisService } from './redis.service';

describe('RedisThrottlerStorage', () => {
  it('uses shared atomic Redis results for allowed and blocked bursts', async () => {
    const evalMock = jest
      .fn()
      .mockResolvedValueOnce([1, 60000, 0, 0])
      .mockResolvedValueOnce([121, 60000, 1, 60000]);
    const redis = {
      eval: evalMock,
    } as unknown as Redis;
    const service = {
      isConfiguredEnabled: jest.fn().mockReturnValue(true),
      getNativeClient: jest.fn().mockReturnValue(redis),
    } as unknown as RedisService;
    const storage = new RedisThrottlerStorage(service);

    await expect(
      storage.increment('route-ip', 60000, 120, 60000, 'default'),
    ).resolves.toEqual({
      totalHits: 1,
      timeToExpire: 60,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
    await expect(
      storage.increment('route-ip', 60000, 120, 60000, 'default'),
    ).resolves.toEqual({
      totalHits: 121,
      timeToExpire: 60,
      isBlocked: true,
      timeToBlockExpire: 60,
    });

    expect(evalMock).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("redis.call('INCR', KEYS[1])"),
      2,
      'throttler:default:route-ip:hits',
      'throttler:default:route-ip:block',
      '60000',
      '120',
      '60000',
    );
  });

  it('uses the existing per-process store when Redis is disabled', async () => {
    const service = {
      isConfiguredEnabled: jest.fn().mockReturnValue(false),
      getNativeClient: jest.fn().mockReturnValue(null),
    } as unknown as RedisService;
    const storage = new RedisThrottlerStorage(service);

    for (let index = 0; index < 120; index += 1) {
      await expect(
        storage.increment('route-ip', 60000, 120, 60000, 'default'),
      ).resolves.toMatchObject({ isBlocked: false });
    }
    await expect(
      storage.increment('route-ip', 60000, 120, 60000, 'default'),
    ).resolves.toMatchObject({ isBlocked: true, totalHits: 121 });
  });

  it('fails closed when configured Redis is unavailable', async () => {
    const service = {
      isConfiguredEnabled: jest.fn().mockReturnValue(true),
      getNativeClient: jest.fn().mockReturnValue(null),
    } as unknown as RedisService;
    const storage = new RedisThrottlerStorage(service);

    await expect(
      storage.increment('route-ip', 60000, 120, 60000, 'default'),
    ).resolves.toEqual({
      totalHits: 121,
      timeToExpire: 1,
      isBlocked: true,
      timeToBlockExpire: 1,
    });
  });
});
