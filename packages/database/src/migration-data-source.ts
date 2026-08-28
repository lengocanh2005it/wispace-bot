import type { DataSource } from 'typeorm';
import { assertPostgresWriter } from '@wispace/bot-common/health';

export const DEFAULT_MIGRATION_LOCK_ID = 4_242_424_242;

type MigrationOptions = {
  transaction?: 'all' | 'none' | 'each';
  fake?: boolean;
};

interface MigrationQueryRunnerSource {
  createQueryRunner(): {
    connect(): Promise<void>;
    query(query: string, parameters?: unknown[]): Promise<unknown>;
    release(): Promise<void>;
  };
}

function isTrue(value: unknown): boolean {
  return value === true || value === 't' || value === 1;
}

/**
 * Keep the migration fence on a dedicated database session. The migration
 * executor uses its own session, so every migration process must acquire this
 * same lock before it starts.
 */
export async function runWithMigrationAdvisoryLock<T>(
  dataSource: MigrationQueryRunnerSource,
  lockId: number,
  operation: () => Promise<T>,
): Promise<T> {
  const runner = dataSource.createQueryRunner();
  let locked = false;
  try {
    await runner.connect();
    await assertPostgresWriter(runner);
    const rows = (await runner.query(
      'SELECT pg_try_advisory_lock($1::bigint) AS acquired',
      [lockId],
    )) as Array<{ acquired?: unknown }>;
    locked = isTrue(rows[0]?.acquired);
    if (!locked) {
      throw new Error(`migration advisory lock ${lockId} is held`);
    }
    return await operation();
  } finally {
    try {
      if (locked) {
        await runner.query('SELECT pg_advisory_unlock($1::bigint)', [lockId]);
      }
    } finally {
      await runner.release();
    }
  }
}

/** Guard TypeORM CLI migration mutations and status checks. */
export function guardDataSourceMigrations(
  dataSource: DataSource,
  lockId: number,
): DataSource {
  const runMigrations = dataSource.runMigrations.bind(dataSource);
  dataSource.runMigrations = (options?: MigrationOptions) =>
    runWithMigrationAdvisoryLock(dataSource, lockId, () =>
      runMigrations(options),
    );

  const undoLastMigration = dataSource.undoLastMigration.bind(dataSource);
  dataSource.undoLastMigration = (options?: MigrationOptions) =>
    runWithMigrationAdvisoryLock(dataSource, lockId, () =>
      undoLastMigration(options),
    );

  const showMigrations = dataSource.showMigrations.bind(dataSource);
  dataSource.showMigrations = async () => {
    await assertPostgresWriter(dataSource);
    return showMigrations();
  };

  return dataSource;
}
