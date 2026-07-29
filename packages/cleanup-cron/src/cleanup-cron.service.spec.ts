import { CleanupCronService } from './cleanup-cron.service';

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
    const { dataSource } = mockDataSource();
    const service = new CleanupCronService(dataSource);
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
    const { dataSource } = mockDataSource(true);
    const service = new CleanupCronService(dataSource);
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
    const { dataSource } = mockDataSource(false);
    const service = new CleanupCronService(dataSource);
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
    const { dataSource } = mockDataSource(true);
    const service = new CleanupCronService(dataSource);
    const deleteFn = jest.fn().mockResolvedValue(0);

    await service.execute(
      config,
      deleteFn,
      () => true,
      () => 3,
    );

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const cutoffArg = (deleteFn.mock.calls as unknown[][])[0][0] as Date;
    const expectedCutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

    // Allow 1s tolerance for execution time
    expect(
      Math.abs(cutoffArg.getTime() - expectedCutoff.getTime()),
    ).toBeLessThan(1000);
  });

  it('unlocks advisory lock even on deleteFn error', async () => {
    const { dataSource, queries } = mockDataSource(true);
    const service = new CleanupCronService(dataSource);
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
});
