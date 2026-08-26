import { acquireRedisSlot } from './redis-slot-limiter';

describe('acquireRedisSlot', () => {
  const mockLogger = { warn: jest.fn() };

  function makeRedis(evalResult?: number) {
    return {
      eval: jest.fn().mockResolvedValue(evalResult ?? 1),
    };
  }

  it('acquires slot and returns release function', async () => {
    const redis = makeRedis(1);
    const release = await acquireRedisSlot(
      redis as never,
      'test',
      10,
      mockLogger,
    );

    expect(typeof release).toBe('function');
    expect(redis.eval).toHaveBeenCalledTimes(1);
  });

  it('passes leaseMs to Lua script', async () => {
    const redis = makeRedis(1);
    await acquireRedisSlot(redis as never, 'test', 10, mockLogger, {
      leaseMs: 120_000,
    });

    const args = redis.eval.mock.calls[0];
    // ARGV[2] is ttl_ms
    expect(args[5]).toBe('120000');
  });

  it('uses default leaseMs (60s) when not provided', async () => {
    const redis = makeRedis(1);
    await acquireRedisSlot(redis as never, 'test', 10, mockLogger);

    const args = redis.eval.mock.calls[0];
    expect(args[5]).toBe('60000');
  });

  it('rejects immediately when signal is already aborted', async () => {
    const redis = makeRedis(1);
    const controller = new AbortController();
    controller.abort();

    await expect(
      acquireRedisSlot(redis as never, 'test', 10, mockLogger, {
        signal: controller.signal,
      }),
    ).rejects.toThrow('Aborted');

    // Should not have called redis.eval at all
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('rejects during retry sleep when signal aborts', async () => {
    const redis = makeRedis(0); // always reject (limit exceeded)
    const controller = new AbortController();

    // Abort after first retry attempt
    setTimeout(() => controller.abort(), 10);

    await expect(
      acquireRedisSlot(redis as never, 'test', 10, mockLogger, {
        signal: controller.signal,
      }),
    ).rejects.toThrow('Aborted');

    // Should have tried at least once before abort
    expect(redis.eval).toHaveBeenCalledTimes(1);
  });
});
