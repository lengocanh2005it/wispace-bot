import { acquireRedisSlot } from './redis-slot-limiter';
import { LlmOverloadError } from './bounded-admission';

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

  it('honors injected retry tuning for fast tests (#389)', async () => {
    const redis = makeRedis(0); // always saturated

    await expect(
      acquireRedisSlot(redis as never, 'test', 10, mockLogger, {
        maxRetries: 3,
        retryDelayMs: 1,
      }),
    ).rejects.toBeInstanceOf(LlmOverloadError);

    expect(redis.eval).toHaveBeenCalledTimes(3);
  });

  it('maps sustained denial to typed global_saturated overload (#389)', async () => {
    const redis = makeRedis(0);
    const metrics = { incrementCounter: jest.fn() };

    await expect(
      acquireRedisSlot(redis as never, 'test', 10, mockLogger, {
        metrics,
        maxRetries: 2,
        retryDelayMs: 1,
      }),
    ).rejects.toMatchObject({
      name: 'LlmOverloadError',
      reason: 'global_saturated',
    });
    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      'llm_admission_rejected_total',
      { reason: 'global_saturated' },
    );
  });

  it('maps sustained redis errors to typed redis_unavailable overload (#389)', async () => {
    const redis = { eval: jest.fn().mockRejectedValue(new Error('down')) };
    const metrics = { incrementCounter: jest.fn() };

    await expect(
      acquireRedisSlot(redis as never, 'test', 10, mockLogger, {
        metrics,
        maxRetries: 2,
        retryDelayMs: 1,
      }),
    ).rejects.toMatchObject({
      name: 'LlmOverloadError',
      reason: 'redis_unavailable',
    });
    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      'llm_admission_rejected_total',
      { reason: 'redis_unavailable' },
    );
  });

  it('aborts a hung acquire command when the caller signal fires (#389)', async () => {
    const controller = new AbortController();
    const redis = {
      eval: jest.fn(
        () =>
          new Promise((_, reject) => {
            controller.signal.addEventListener(
              'abort',
              () => reject(new Error('hung command aborted')),
              { once: true },
            );
          }),
      ),
    };

    const pending = acquireRedisSlot(redis as never, 'test', 10, mockLogger, {
      signal: controller.signal,
    });
    const expectation = expect(pending).rejects.toThrow('Aborted');
    setTimeout(() => controller.abort(), 20);

    await expectation;
  });

  it('aborts immediately when already aborted before a hung command (#389)', async () => {
    const controller = new AbortController();
    controller.abort();
    const redis = {
      eval: jest.fn(
        () =>
          new Promise((_, reject) => {
            controller.signal.addEventListener(
              'abort',
              () => reject(new Error('hung command aborted')),
              { once: true },
            );
          }),
      ),
    };

    await expect(
      acquireRedisSlot(redis as never, 'test', 10, mockLogger, {
        signal: controller.signal,
      }),
    ).rejects.toThrow('Aborted');
  });

  it('caps total acquire wait to the admission budget (#389)', async () => {
    const redis = makeRedis(0); // always saturated, default cadence 50ms
    const startedAt = Date.now();

    await expect(
      acquireRedisSlot(redis as never, 'test', 10, mockLogger, {
        waitBudgetMs: 120,
      }),
    ).rejects.toMatchObject({
      name: 'LlmOverloadError',
      reason: 'global_saturated',
    });

    // ~3 attempts * 50ms + slack — far below the legacy ~10s loop.
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });
});
