import type { DataSource } from 'typeorm';
import {
  LEGACY_MIGRATION_NAME_ALIASES,
  guardDataSourceMigrations,
  runWithMigrationAdvisoryLock,
} from './migration-data-source';

function buildRunner(query: jest.Mock) {
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    query,
    release: jest.fn().mockResolvedValue(undefined),
  };
}

describe('migration data source guards', () => {
  it('skips corrected migrations whose historical names are already applied', async () => {
    const runnerQuery = jest
      .fn()
      .mockResolvedValueOnce([{ in_recovery: false }])
      .mockResolvedValueOnce([{ acquired: true }])
      .mockResolvedValueOnce([]);
    const runner = buildRunner(runnerQuery);
    const legacyName = 'AddBurstLimitReservationIndex1751029200016';
    const currentName = LEGACY_MIGRATION_NAME_ALIASES[legacyName];
    const currentMigration = { name: currentName };
    const otherMigration = { name: 'OtherMigration1786920000015' };
    const readMigrations = jest.fn().mockResolvedValue([{ name: legacyName }]);
    const dataSource = {
      createQueryRunner: jest.fn().mockReturnValue(runner),
      query: readMigrations,
      migrations: [currentMigration, otherMigration],
      options: { migrationsTableName: 'migrations' },
      runMigrations: jest.fn(async () => {
        expect(dataSource.migrations).toEqual([otherMigration]);
        return [];
      }),
      undoLastMigration: jest.fn(),
      showMigrations: jest.fn(),
    } as unknown as DataSource;

    guardDataSourceMigrations(dataSource, 99);
    await dataSource.runMigrations();

    expect(readMigrations).toHaveBeenCalledWith(
      'SELECT "name" FROM "migrations" ORDER BY "id" DESC',
    );
    expect(dataSource.migrations).toEqual([currentMigration, otherMigration]);
  });

  it('marks legacy names as applied for migration:show without rewriting rows', async () => {
    const currentName =
      LEGACY_MIGRATION_NAME_ALIASES['AddWebhookInboundStaleIndex1751029200017'];
    const currentMigration = { name: currentName };
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ in_recovery: false }])
      .mockResolvedValueOnce([
        { name: 'AddWebhookInboundStaleIndex1751029200017' },
      ]);
    const dataSource = {
      query,
      migrations: [currentMigration],
      options: { migrationsTableName: 'migrations' },
      runMigrations: jest.fn(),
      undoLastMigration: jest.fn(),
      showMigrations: jest.fn(async () => {
        expect(dataSource.migrations).toEqual([]);
        return false;
      }),
    } as unknown as DataSource;

    guardDataSourceMigrations(dataSource, 99);
    await expect(dataSource.showMigrations()).resolves.toBe(false);

    expect(dataSource.migrations).toEqual([currentMigration]);
  });

  it('reverts a legacy row through its corrected migration implementation', async () => {
    const runnerQuery = jest
      .fn()
      .mockResolvedValueOnce([{ in_recovery: false }])
      .mockResolvedValueOnce([{ acquired: true }])
      .mockResolvedValueOnce([]);
    const runner = buildRunner(runnerQuery);
    const legacyName = 'AddZaloOaTokenVersion1751029200017';
    const currentName = LEGACY_MIGRATION_NAME_ALIASES[legacyName];
    const migration = { name: currentName };
    const readMigrations = jest.fn().mockResolvedValue([{ name: legacyName }]);
    const dataSource = {
      createQueryRunner: jest.fn().mockReturnValue(runner),
      query: readMigrations,
      migrations: [migration],
      options: { migrationsTableName: 'migrations' },
      runMigrations: jest.fn(),
      undoLastMigration: jest.fn(async () => {
        expect(migration.name).toBe(legacyName);
      }),
      showMigrations: jest.fn(),
    } as unknown as DataSource;

    guardDataSourceMigrations(dataSource, 99);
    await dataSource.undoLastMigration();

    expect(migration.name).toBe(currentName);
  });

  it('checks the writer and holds the advisory lock while migrations run', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ in_recovery: false }])
      .mockResolvedValueOnce([{ acquired: true }])
      .mockResolvedValueOnce([]);
    const runner = buildRunner(query);
    const runMigrations = jest.fn().mockResolvedValue(['001']);
    const dataSource = {
      createQueryRunner: jest.fn().mockReturnValue(runner),
      runMigrations,
      undoLastMigration: jest.fn(),
      showMigrations: jest.fn(),
    } as unknown as DataSource;

    guardDataSourceMigrations(dataSource, 99);
    await dataSource.runMigrations();

    expect(query).toHaveBeenNthCalledWith(
      1,
      'SELECT pg_is_in_recovery() AS in_recovery',
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      'SELECT pg_try_advisory_lock($1::bigint) AS acquired',
      [99],
    );
    expect(runMigrations).toHaveBeenCalled();
    expect(query).toHaveBeenNthCalledWith(
      3,
      'SELECT pg_advisory_unlock($1::bigint)',
      [99],
    );
    expect(runner.release).toHaveBeenCalled();
  });

  it('fails closed before running a migration on a standby', async () => {
    const query = jest.fn().mockResolvedValue([{ in_recovery: true }]);
    const runner = buildRunner(query);
    const runMigrations = jest.fn();
    const dataSource = {
      createQueryRunner: jest.fn().mockReturnValue(runner),
      runMigrations,
      undoLastMigration: jest.fn(),
      showMigrations: jest.fn(),
    } as unknown as DataSource;

    guardDataSourceMigrations(dataSource, 99);
    await expect(dataSource.runMigrations()).rejects.toThrow(
      'not a writable primary',
    );
    expect(runMigrations).not.toHaveBeenCalled();
    expect(runner.release).toHaveBeenCalled();
  });

  it('does not run a concurrent migration when the lock is held', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ in_recovery: false }])
      .mockResolvedValueOnce([{ acquired: false }]);
    const runner = buildRunner(query);

    await expect(
      runWithMigrationAdvisoryLock(
        { createQueryRunner: jest.fn().mockReturnValue(runner) },
        99,
        jest.fn(),
      ),
    ).rejects.toThrow('migration advisory lock 99 is held');
    expect(runner.release).toHaveBeenCalled();
  });
});
