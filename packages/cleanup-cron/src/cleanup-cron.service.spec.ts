import { CleanupCronService } from './cleanup-cron.service';
import { PgAdvisoryLockService } from '@wispace/bot-common/locks';

function mockDataSource(acquired = true) {
  const queries: string[] = [];
  return {
    dataSource: {
      createQueryRunner: () => ({
        connect: jest.fn().mockResolvedValue(undefined),
        release: jest.fn().mockResolvedValue(undefined),
        query: jest.fn().mockImplementation((sql: string) => {
          queries.push(sql);
          if (sql.includes('pg_try_advisory_lock')) {
            return Promise.resolve([{ acquired }]);
          }
          if (sql.includes('pg_advisory_unlock')) {
            return Promise.resolve([{}]);
          }
          return Promise.resolve([]);
        }),
      }),
    } as never,
    queries,
  };
}

function buildService(acquired = true): {
  service: CleanupCronService;
  queries: string[];
} {
  const { dataSource, queries } = mockDataSource(acquired);
  const pgLock = new PgAdvisoryLockService(dataSource);
  return { service: new CleanupCronService(dataSource, pgLock), queries };
}

describe('CleanupCronService', () => {
  const config = {
    name: 'test-cleanup',
    advisoryLockId: 12345,
    cronExpression: '0 0 3 * * *',
    enabledConfigKey: 'TEST_CLEANUP_ENABLED',
    retentionDaysConfigKey: 'TEST_CLEANUP_RETENTION_DAYS',
    defaultRetentionDays: 7,
  };

  it('returns null when disabled', async () => {
    const { service } = buildService();
    const deleteFn = jest.fn().mockResolvedValue(0);

    const result = await service.execute(
      config,
      deleteFn,
      () => false,
      () => 7,
    );

    expect(result).toBeNull();
    expect(deleteFn).not.toHaveBeenCalled();
  });

  it('acquires advisory lock and runs deleteFn', async () => {
    const { service } = buildService(true);
    const deleteFn = jest.fn().mockResolvedValue(42);

    const result = await service.execute(
      config,
      deleteFn,
      () => true,
      () => 7,
    );

    expect(result).not.toBeNull();
    expect(result!.deleted).toBe(42);
    expect(deleteFn).toHaveBeenCalledTimes(1);
    expect(deleteFn).toHaveBeenCalledWith(expect.any(Date));
  });

  it('returns null when advisory lock not acquired', async () => {
    const { service } = buildService(false);
    const deleteFn = jest.fn().mockResolvedValue(0);

    const result = await service.execute(
      config,
      deleteFn,
      () => true,
      () => 7,
    );

    expect(result).toBeNull();
    expect(deleteFn).not.toHaveBeenCalled();
  });

  it('computes cutoff from retention days', async () => {
    const { service } = buildService(true);
    const deleteFn = jest.fn().mockResolvedValue(0);

    await service.execute(
      config,
      deleteFn,
      () => true,
      () => 3,
    );

    const cutoffArg = (deleteFn.mock.calls as unknown[][])[0][0] as Date;
    const expectedCutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

    // Allow 1s tolerance for execution time
    expect(
      Math.abs(cutoffArg.getTime() - expectedCutoff.getTime()),
    ).toBeLessThan(1000);
  });

  it('unlocks advisory lock even on deleteFn error', async () => {
    const { service, queries } = buildService(true);
    const deleteFn = jest.fn().mockRejectedValue(new Error('DB error'));

    await expect(
      service.execute(
        config,
        deleteFn,
        () => true,
        () => 7,
      ),
    ).rejects.toThrow('DB error');

    expect(queries).toContain('SELECT pg_advisory_unlock($1::bigint)');
  });

  it('concurrent executions are serialized by advisory lock', async () => {
    const order: string[] = [];
    let resolve1!: () => void;
    const gate1 = new Promise<void>((r) => {
      resolve1 = r;
    });

    const deleteFn1 = jest.fn().mockImplementation(async () => {
      order.push('start-1');
      await gate1;
      order.push('end-1');
      return 10;
    });
    const deleteFn2 = jest.fn().mockImplementation(async () => {
      order.push('start-2');
      order.push('end-2');
      return 5;
    });

    const { service } = buildService(true);
    // Mock pgLock.withLock to serialize: first call holds gate, second waits
    let lockHeld = false;
    const waitingResolvers: Array<() => void> = [];
    const pgLock = service['pgLock'];
    const originalWithLock = pgLock.withLock.bind(pgLock);
    pgLock.withLock = jest
      .fn()
      .mockImplementation(
        async (lockId: number, fn: () => Promise<unknown>) => {
          while (lockHeld) {
            await new Promise<void>((r) => waitingResolvers.push(r));
          }
          lockHeld = true;
          try {
            return await originalWithLock(lockId, fn);
          } finally {
            lockHeld = false;
            waitingResolvers.shift()?.();
          }
        },
      );

    // Start both concurrently
    const p1 = service.execute(
      config,
      deleteFn1,
      () => true,
      () => 7,
    );
    await new Promise((r) => setTimeout(r, 10));
    const p2 = service.execute(
      config,
      deleteFn2,
      () => true,
      () => 7,
    );

    resolve1();
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1!.deleted).toBe(10);
    expect(r2!.deleted).toBe(5);
    expect(order).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);
  });
});
