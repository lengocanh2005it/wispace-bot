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
    const reconciler = new RedisBurstReconciler(
      { isEnabled: () => true, getNativeClient: () => client as never },
      repository,
      { platform: 'messenger', now: () => now, metrics },
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
