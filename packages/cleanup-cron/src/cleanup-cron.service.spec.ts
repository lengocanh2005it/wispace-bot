import { ConfigService } from '@nestjs/config';
import { PgAdvisoryLockService } from '@wispace/bot-common/locks';
import { CleanupCronService } from './cleanup-cron.service';

function buildService(
  acquired = true,
  values: Record<string, string> = {},
): { service: CleanupCronService; queries: string[] } {
  const queries: string[] = [];
  const dataSource = {
    createQueryRunner: () => ({
      connect: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockImplementation((sql: string) => {
        queries.push(sql);
        if (sql.includes('pg_try_advisory_lock')) {
          return Promise.resolve([{ acquired }]);
        }
        if (sql.includes('pg_advisory_unlock')) return Promise.resolve([{}]);
        return Promise.resolve([]);
      }),
    }),
  } as never;
  const config = {
    get: jest.fn((key: string) => values[key]),
  } as never as ConfigService;
  return {
    service: new CleanupCronService(
      config,
      new PgAdvisoryLockService(dataSource),
    ),
    queries,
  };
}

describe('CleanupCronService', () => {
  it('returns null when the registered policy is disabled', async () => {
    const { service } = buildService(true, {
      MESSENGER_MESSAGE_LOG_CLEANUP_ENABLED: 'false',
    });
    const deleteFn = jest.fn().mockResolvedValue(0);

    const result = await service.execute(
      'messenger-message-log-cleanup',
      12345,
      deleteFn,
    );

    expect(result).toBeNull();
    expect(deleteFn).not.toHaveBeenCalled();
  });

  it('acquires the advisory lock and runs the delete operation', async () => {
    const { service } = buildService(true);
    const deleteFn = jest.fn().mockResolvedValue(42);

    const result = await service.execute(
      'messenger-message-log-cleanup',
      12345,
      deleteFn,
    );

    expect(result?.deleted).toBe(42);
    expect(deleteFn).toHaveBeenCalledWith(expect.any(Date));
  });

  it('returns null when the advisory lock is not acquired', async () => {
    const { service } = buildService(false);
    const deleteFn = jest.fn().mockResolvedValue(0);

    const result = await service.execute(
      'messenger-message-log-cleanup',
      12345,
      deleteFn,
    );

    expect(result).toBeNull();
    expect(deleteFn).not.toHaveBeenCalled();
  });

  it('uses the registered retention policy to compute the cutoff', async () => {
    const { service } = buildService(true, {
      MESSENGER_MESSAGE_LOG_RETENTION_DAYS: '3',
    });
    const deleteFn = jest.fn().mockResolvedValue(0);

    await service.execute('messenger-message-log-cleanup', 12345, deleteFn);

    const cutoff = deleteFn.mock.calls[0][0] as Date;
    expect(
      Math.abs(cutoff.getTime() - (Date.now() - 3 * 24 * 60 * 60 * 1000)),
    ).toBeLessThan(1000);
  });

  it('fails explicitly for an unknown cleanup policy', async () => {
    const { service } = buildService();

    await expect(
      service.execute('unknown-cleanup', 12345, jest.fn()),
    ).rejects.toThrow('Unknown cleanup policy');
  });

  it('does not invent a cutoff for a no-retention policy', async () => {
    const { service } = buildService(true);
    const deleteFn = jest.fn().mockResolvedValue(1);

    await service.execute('messenger-idempotency-recovery', 12345, deleteFn);

    expect(deleteFn).toHaveBeenCalledWith(undefined);
  });

  it('unlocks the advisory lock when the delete operation fails', async () => {
    const { service, queries } = buildService(true);

    await expect(
      service.execute(
        'messenger-message-log-cleanup',
        12345,
        jest.fn().mockRejectedValue(new Error('DB error')),
      ),
    ).rejects.toThrow('DB error');

    expect(queries).toContain('SELECT pg_advisory_unlock($1::bigint)');
  });
});
