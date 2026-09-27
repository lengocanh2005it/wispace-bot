import { acquireRedisSlot } from './redis-slot-limiter';
import { LlmOverloadError } from './bounded-admission';

describe('acquireRedisSlot', () => {
  const mockLogger = { warn: jest.fn() };

  function makeRedis(evalResult?: number) {
    return {
      eval: jest.fn().mockResolvedValue(evalResult ?? 1),
    };
  }

  /**
   * Records the delay `abortableSleep` asks for and fires it straight away.
   *
   * The acquire loop's only timer is that sleep, so this is the whole timing
   * surface. Asserting the requested delay rather than the wall clock it
   * happens to take keeps the test a property of the limiter instead of a
   * property of how busy the machine is.
   */
  function captureRequestedSleeps() {
    const requested: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = jest.spyOn(globalThis, 'setTimeout').mockImplementation(((
      handler: TimerHandler,
      timeout?: number,
      ...rest: unknown[]
    ) => {
      requested.push(Number(timeout) || 0);
      return realSetTimeout(handler, 0, ...rest);
    }) as unknown as typeof globalThis.setTimeout);
    return {
      ms: () => requested,
      restore: () => spy.mockRestore(),
    };
  }

  it('acquires slot and returns release function', async () => {
    const redis = makeRedis(1);
    const metrics = { incrementCounter: jest.fn() };
    const release = await acquireRedisSlot(
      redis as never,
      'test',
      10,
      mockLogger,
      { metrics },
    );

    expect(typeof release).toBe('function');
    expect(redis.eval).toHaveBeenCalledTimes(1);
    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      'llm_concurrency_acquired',
    );

    await release();
    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      'llm_concurrency_released',
    );
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
    // Pin jitter high so the first backoff is the full base delay — the
    // 10ms abort lands inside sleep 1 deterministically (#453 jitter).
    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.9999);

    // Abort after first retry attempt
    setTimeout(() => controller.abort(), 10);

    try {
      await expect(
        acquireRedisSlot(redis as never, 'test', 10, mockLogger, {
          signal: controller.signal,
          retryDelayMs: 60,
        }),
      ).rejects.toThrow('Aborted');

      // Should have tried at least once before abort
      expect(redis.eval).toHaveBeenCalledTimes(1);
    } finally {
      randomSpy.mockRestore();
    }
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
      'llm_concurrency_rejected',
    );
    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      'llm_admission_rejected_total',
      { reason: 'global_saturated' },
    );
  });

  it('records stale and failed releases as lifecycle outcomes', async () => {
    const staleRedis = {
      eval: jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0),
    };
    const staleMetrics = { incrementCounter: jest.fn() };
    const staleRelease = await acquireRedisSlot(
      staleRedis as never,
      'test',
      10,
      mockLogger,
      { metrics: staleMetrics },
    );
    await staleRelease();
    expect(staleMetrics.incrementCounter).toHaveBeenCalledWith(
      'llm_concurrency_stale_release',
    );

    const failedRedis = {
      eval: jest
        .fn()
        .mockResolvedValueOnce(1)
        .mockRejectedValueOnce(new Error('release down')),
    };
    const failedMetrics = { incrementCounter: jest.fn() };
    const failedRelease = await acquireRedisSlot(
      failedRedis as never,
      'test',
      10,
      mockLogger,
      { metrics: failedMetrics },
    );
    await failedRelease();
    expect(failedMetrics.incrementCounter).toHaveBeenCalledWith(
      'llm_concurrency_release_error',
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

  it('releases a lease acquired after the caller aborts (#867)', async () => {
    const controller = new AbortController();
    let resolveAcquire!: (value: number) => void;
    const redis = {
      eval: jest
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<number>((resolve) => {
              resolveAcquire = resolve;
            }),
        )
        .mockResolvedValueOnce(1),
    };

    const pending = acquireRedisSlot(redis as never, 'test', 10, mockLogger, {
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort(new Error('caller gone'));
    await expect(pending).rejects.toThrow('caller gone');

    resolveAcquire(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(redis.eval).toHaveBeenCalledTimes(2);
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

  it('fails fast after the consecutive Redis error budget (#453)', async () => {
    const redis = { eval: jest.fn().mockRejectedValue(new Error('down')) };
    const metrics = { incrementCounter: jest.fn() };

    await expect(
      acquireRedisSlot(redis as never, 'test', 10, mockLogger, {
        metrics,
        maxRetries: 10,
        retryDelayMs: 1,
        maxConsecutiveRedisErrors: 2,
      }),
    ).rejects.toMatchObject({
      name: 'LlmOverloadError',
      reason: 'redis_unavailable',
    });

    // 2 failed EVALs — not the full 10-attempt retry budget.
    expect(redis.eval).toHaveBeenCalledTimes(2);
    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      'llm_admission_rejected_total',
      { reason: 'redis_unavailable' },
    );
  });

  it('recovers the consecutive-error counter when Redis responds again (#453)', async () => {
    // Error, error, then a real (saturated) response, then more errors:
    // the counter must reset on any successful EVAL, so the loop keeps
    // retrying past the per-call error budget.
    const redis = {
      eval: jest
        .fn()
        .mockRejectedValueOnce(new Error('down'))
        .mockRejectedValueOnce(new Error('down'))
        .mockResolvedValueOnce(0)
        .mockRejectedValue(new Error('down')),
    };

    await expect(
      acquireRedisSlot(redis as never, 'test', 10, mockLogger, {
        maxRetries: 8,
        retryDelayMs: 1,
        maxConsecutiveRedisErrors: 3,
      }),
    ).rejects.toMatchObject({ reason: 'redis_unavailable' });

    // 2 errors + 1 saturated response + 3 more errors before the
    // consecutive budget trips again.
    expect(redis.eval).toHaveBeenCalledTimes(6);
  });

  it('jitters retry delays across the full [0, backoff) range (#453)', async () => {
    // random() pinned to ~1 → the sleep sits at the top of the range the
    // growing backoff offers, so the cadence widens instead of repeating.
    const redis = makeRedis(0);
    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.9999);
    const fullJitter = captureRequestedSleeps();

    await expect(
      acquireRedisSlot(redis as never, 'test', 10, mockLogger, {
        maxRetries: 4,
        retryDelayMs: 100,
      }),
    ).rejects.toBeInstanceOf(LlmOverloadError);

    fullJitter.restore();
    randomSpy.mockRestore();

    expect(redis.eval).toHaveBeenCalledTimes(4);
    // One sleep after each attempt but the last, so four retries ask for
    // three: 100, then 200, then 400.
    expect(fullJitter.ms()).toEqual([
      expect.closeTo(100, 1),
      expect.closeTo(200, 1),
      expect.closeTo(400, 1),
    ]);

    // random() pinned to 0 → every requested delay collapses to 0, so callers
    // that all draw the same jitter still never retry on a fixed cadence.
    const zeroRandom = jest.spyOn(Math, 'random').mockReturnValue(0);
    const zeroRedis = makeRedis(0);
    const zeroJitter = captureRequestedSleeps();

    await expect(
      acquireRedisSlot(zeroRedis as never, 'test', 10, mockLogger, {
        maxRetries: 4,
        retryDelayMs: 100,
      }),
    ).rejects.toBeInstanceOf(LlmOverloadError);

    zeroJitter.restore();
    zeroRandom.mockRestore();

    expect(zeroRedis.eval).toHaveBeenCalledTimes(4);
    expect(zeroJitter.ms()).toEqual([0, 0, 0]);
  });
});
