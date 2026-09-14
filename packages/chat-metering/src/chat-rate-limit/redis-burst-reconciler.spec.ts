import { RedisBurstReconciler } from './redis-burst-reconciler';

describe('RedisBurstReconciler', () => {
  const now = new Date('2026-06-15T01:00:30.000Z');

  it('invalidates a present divergent advisory key and ignores cache misses', async () => {
    const client = {
      set: jest.fn().mockResolvedValue('OK'),
      get: jest.fn().mockResolvedValueOnce('9').mockResolvedValueOnce(null),
      del: jest.fn().mockResolvedValue(1),
      eval: jest.fn().mockResolvedValue(1),
    };
    const repository = {
      listBurstCountsForBucket: jest.fn().mockResolvedValue({
        rows: [
          { externalUserId: 'user-1', count: 2 },
          { externalUserId: 'user-2', count: 1 },
        ],
        truncated: false,
      }),
    };
    const metrics = {
      setRedisConsistencyDrift: jest.fn(),
      incRedisConsistencyEvent: jest.fn(),
    };
    const pgLock = {
      withLock: jest.fn((_lockId: number, run: () => Promise<unknown>) =>
        run(),
      ),
    };
    const reconciler = new RedisBurstReconciler(
      { isEnabled: () => true, getNativeClient: () => client as never },
      repository,
      {
        platform: 'messenger',
        now: () => now,
        metrics,
        pgLock: pgLock as never,
        lockId: 123,
      },
    );

    await expect(reconciler.reconcile()).resolves.toMatchObject({
      status: 'clean',
      scanned: 2,
      mismatches: 1,
      repaired: 1,
      unresolved: 0,
    });
    expect(client.del).toHaveBeenCalledWith(
      expect.stringContaining('burst:messenger:user-1:'),
      expect.stringContaining('burst:user-1:'),
    );
    expect(metrics.setRedisConsistencyDrift).toHaveBeenCalledWith('burst', 0);
  });

  it('counts a Redis read failure as one failed item and continues the batch', async () => {
    const client = {
      get: jest
        .fn()
        .mockRejectedValueOnce(new Error('Redis timeout'))
        .mockResolvedValueOnce(null),
      del: jest.fn(),
    };
    const repository = {
      listBurstCountsForBucket: jest.fn().mockResolvedValue({
        rows: [
          { externalUserId: 'user-1', count: 2 },
          { externalUserId: 'user-2', count: 1 },
        ],
        truncated: false,
      }),
    };
    const pgLock = {
      withLock: jest.fn((_lockId: number, run: () => Promise<unknown>) =>
        run(),
      ),
    };
    const metrics = {
      setRedisConsistencyDrift: jest.fn(),
      incRedisConsistencyEvent: jest.fn(),
    };
    const reconciler = new RedisBurstReconciler(
      { isEnabled: () => true, getNativeClient: () => client as never },
      repository,
      {
        platform: 'messenger',
        now: () => now,
        metrics,
        pgLock: pgLock as never,
        lockId: 123,
      },
    );

    await expect(reconciler.reconcile()).resolves.toMatchObject({
      status: 'drift',
      scanned: 2,
      unresolved: 1,
    });
    expect(client.get).toHaveBeenCalledTimes(3);
    expect(metrics.setRedisConsistencyDrift).toHaveBeenCalledWith('burst', 1);
  });

  it('fails closed when no PostgreSQL advisory lock is configured', async () => {
    const client = {
      get: jest.fn(),
    };
    const reconciler = new RedisBurstReconciler(
      { isEnabled: () => true, getNativeClient: () => client as never },
      { listBurstCountsForBucket: jest.fn() },
    );

    await expect(reconciler.reconcile()).resolves.toMatchObject({
      status: 'unavailable',
    });
    expect(client.get).not.toHaveBeenCalled();
  });

  it('fails closed as unavailable when Redis is not connected', async () => {
    const metrics = {
      setRedisConsistencyDrift: jest.fn(),
      incRedisConsistencyEvent: jest.fn(),
    };
    const reconciler = new RedisBurstReconciler(
      { isEnabled: () => true, getNativeClient: () => null },
      { listBurstCountsForBucket: jest.fn() },
      { metrics },
    );

    await expect(reconciler.reconcile()).resolves.toMatchObject({
      status: 'unavailable',
    });
    expect(metrics.incRedisConsistencyEvent).toHaveBeenCalledWith(
      'burst',
      'unavailable',
      1,
    );
  });
});
