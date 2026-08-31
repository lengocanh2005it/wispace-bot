import { DATA_QUALITY_DEFAULTS } from './data-quality.config';
import {
  TypeormDataQualityDatabase,
  TypeormDataQualityRepository,
} from './typeorm-data-quality.repository';
import type {
  DataQualityConfig,
  DataQualityDatabasePort,
  DataQualityQueryInput,
} from './data-quality.types';

const config: DataQualityConfig = { ...DATA_QUALITY_DEFAULTS };
const input: DataQualityQueryInput = {
  config,
  window: {
    now: new Date('2026-08-31T02:15:00.000Z'),
    currentStart: new Date('2026-08-29T17:00:00.000Z'),
    currentEnd: new Date('2026-08-30T17:00:00.000Z'),
    baselineStart: new Date('2026-08-22T17:00:00.000Z'),
    baselineEnd: new Date('2026-08-29T17:00:00.000Z'),
  },
};

function buildDatabase(): {
  database: DataQualityDatabasePort;
  query: jest.Mock;
} {
  const query = jest.fn().mockImplementation((sql: string) => {
    if (sql.includes('WITH calendar')) {
      return Promise.resolve([
        {
          current_count: '20',
          baseline_count: '4',
          current_total: '100',
          baseline_total: '70',
        },
      ]);
    }
    return Promise.resolve([
      {
        anomaly_count: '2',
        sample_key: '12345678901234',
        user_id: 42,
        external_user_id: 'external-123456789',
        platform: 'messenger',
      },
    ]);
  });
  const database: DataQualityDatabasePort = {
    withReadOnly: jest.fn((_timeout, operation) => operation({ query })),
  };
  return { database, query };
}

describe('TypeormDataQualityRepository', () => {
  it('returns null-spike observations with current and baseline counts', async () => {
    const { database, query } = buildDatabase();
    const repository = new TypeormDataQualityRepository(database);

    const observations = await repository.getNullSpikeObservations(input);

    expect(observations.length).toBeGreaterThan(0);
    expect(observations[0]).toMatchObject({
      count: 20,
      baselineCount: 4,
      totalCount: 100,
      baselineTotalCount: 70,
    });
    expect(observations[0].samples?.[0]).toMatchObject({
      table: 'chat_daily_usage',
      key: '12345678901234',
      userId: 42,
      externalUserId: 'external-123456789',
    });
    expect(database.withReadOnly).toHaveBeenCalled();
    expect(
      query.mock.calls.every(([sql]) => /^\s*(SELECT|WITH)\b/i.test(sql)),
    ).toBe(true);
  });

  it('covers future, terminal, stuck, orphan and volume catalogs', async () => {
    const { database, query } = buildDatabase();
    const repository = new TypeormDataQualityRepository(database);

    const future = await repository.getFutureTimestampObservations(input);
    const terminal = await repository.getTerminalTimestampObservations(input);
    const stuck = await repository.getStuckStateObservations(input);
    const orphan = await repository.getOrphanGrowthObservations(input);
    const volume = await repository.getVolumeObservations(input);

    expect(future.length).toBeGreaterThan(0);
    expect(terminal.length).toBeGreaterThan(0);
    expect(stuck.length).toBeGreaterThan(0);
    expect(orphan.length).toBeGreaterThan(0);
    expect(volume.length).toBeGreaterThan(0);
    expect(query.mock.calls.some(([sql]) => sql.includes('NOT EXISTS'))).toBe(
      true,
    );
    expect(
      query.mock.calls.some(
        ([sql]) =>
          sql.includes('"scheduled_at"') &&
          sql.includes("status IN ('sent', 'failed', 'cancelled')"),
      ),
    ).toBe(true);
    expect(
      query.mock.calls.some(
        ([sql]) =>
          sql.includes('"remind_at"') &&
          sql.includes("status IN ('sent', 'failed', 'cancelled')"),
      ),
    ).toBe(true);
    expect(
      query.mock.calls.every(([sql]) => /^\s*(SELECT|WITH)\b/i.test(sql)),
    ).toBe(true);
  });
});

describe('TypeormDataQualityDatabase', () => {
  it('wraps each operation in a read-only transaction with a local timeout', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const runner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      query,
    };
    const dataSource = {
      createQueryRunner: jest.fn().mockReturnValue(runner),
    } as never;
    const database = new TypeormDataQualityDatabase(dataSource);

    await database.withReadOnly(5000, async (queryPort) => {
      await queryPort.query('SELECT 1');
    });

    expect(query).toHaveBeenNthCalledWith(1, 'SET TRANSACTION READ ONLY');
    expect(query).toHaveBeenNthCalledWith(
      2,
      `SELECT set_config('statement_timeout', $1, true)`,
      ['5000ms'],
    );
    expect(query).toHaveBeenCalledWith('SELECT 1', []);
    expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
    expect(runner.release).toHaveBeenCalledTimes(1);
  });
});
