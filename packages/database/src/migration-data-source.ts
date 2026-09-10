import type { DataSource, MigrationInterface } from 'typeorm';
import { assertPostgresWriter } from '@wispace/bot-common/health';

export const DEFAULT_MIGRATION_LOCK_ID = 4_242_424_242;

/**
 * TypeORM persists `migration.name` and derives its ordering timestamp from
 * the same string. These four historical names collide, so their source
 * migrations now use unique names. An already-applied legacy row still
 * represents the same schema change and is treated as the corresponding
 * migration without rewriting the row.
 */
export const LEGACY_MIGRATION_NAME_ALIASES: Readonly<Record<string, string>> =
  Object.freeze({
    AddBurstLimitReservationIndex1751029200016:
      'AddBurstLimitReservationIndex1786920000013',
    AddZaloOauthStateCleanupIndex1751029200016:
      'AddZaloOauthStateCleanupIndex1786920000005',
    AddZaloOaTokenVersion1751029200017: 'AddZaloOaTokenVersion1786920000014',
    AddWebhookInboundStaleIndex1751029200017:
      'AddWebhookInboundStaleIndex1786920000006',
  });

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

interface ExecutedMigrationRecord {
  name: string;
}

const CURRENT_TO_LEGACY_MIGRATION_NAME = new Map(
  Object.entries(LEGACY_MIGRATION_NAME_ALIASES).map(
    ([legacyName, currentName]) => [currentName, legacyName],
  ),
);

function migrationName(migration: MigrationInterface): string {
  return migration.name ?? migration.constructor.name;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function migrationsTableName(dataSource: DataSource): string {
  const table = quoteIdentifier(
    dataSource.options.migrationsTableName ?? 'migrations',
  );
  const schema = (dataSource.options as { schema?: unknown }).schema;
  return typeof schema === 'string' && schema.trim() !== ''
    ? `${quoteIdentifier(schema)}.${table}`
    : table;
}

function isMissingMigrationsTable(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '42P01'
  );
}

async function readExecutedMigrationRecords(
  dataSource: DataSource,
): Promise<ExecutedMigrationRecord[]> {
  try {
    const rows = (await dataSource.query(
      `SELECT "name" FROM ${migrationsTableName(dataSource)} ORDER BY "id" DESC`,
    )) as unknown;
    if (!Array.isArray(rows)) return [];
    return rows.filter(
      (row): row is ExecutedMigrationRecord =>
        typeof row === 'object' &&
        row !== null &&
        typeof (row as { name?: unknown }).name === 'string',
    );
  } catch (error: unknown) {
    if (isMissingMigrationsTable(error)) return [];
    throw error;
  }
}

async function withLegacyMigrationCompatibility<T>(
  dataSource: DataSource,
  operation: () => Promise<T>,
): Promise<T> {
  const migrations = dataSource.migrations;
  if (!Array.isArray(migrations)) return operation();

  const currentNames = new Set(
    migrations
      .map(migrationName)
      .filter((name) => CURRENT_TO_LEGACY_MIGRATION_NAME.has(name)),
  );
  if (currentNames.size === 0) return operation();

  const executedNames = await readExecutedMigrationRecords(dataSource);
  const appliedCurrentNames = new Set(
    executedNames
      .map(({ name }) => LEGACY_MIGRATION_NAME_ALIASES[name])
      .filter(
        (name): name is string => name !== undefined && currentNames.has(name),
      ),
  );
  if (appliedCurrentNames.size === 0) return operation();

  Object.assign(dataSource, {
    migrations: migrations.filter(
      (migration) => !appliedCurrentNames.has(migrationName(migration)),
    ),
  });
  try {
    return await operation();
  } finally {
    Object.assign(dataSource, { migrations });
  }
}

async function withLegacyMigrationRevert<T>(
  dataSource: DataSource,
  operation: () => Promise<T>,
): Promise<T> {
  const migrations = dataSource.migrations;
  if (!Array.isArray(migrations)) return operation();

  const [latestExecuted] = await readExecutedMigrationRecords(dataSource);
  const legacyName = latestExecuted?.name;
  const currentName = legacyName
    ? LEGACY_MIGRATION_NAME_ALIASES[legacyName]
    : undefined;
  if (!legacyName || !currentName) return operation();

  const migration = migrations.find(
    (candidate) => migrationName(candidate) === currentName,
  );
  if (!migration) {
    throw new Error(
      `Legacy migration ${legacyName} maps to missing ${currentName}`,
    );
  }

  const originalName = migration.name;
  migration.name = legacyName;
  try {
    return await operation();
  } finally {
    migration.name = originalName;
  }
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
      withLegacyMigrationCompatibility(dataSource, () =>
        runMigrations(options),
      ),
    );

  const undoLastMigration = dataSource.undoLastMigration.bind(dataSource);
  dataSource.undoLastMigration = (options?: MigrationOptions) =>
    runWithMigrationAdvisoryLock(dataSource, lockId, () =>
      withLegacyMigrationRevert(dataSource, () => undoLastMigration(options)),
    );

  const showMigrations = dataSource.showMigrations.bind(dataSource);
  dataSource.showMigrations = async () => {
    await assertPostgresWriter(dataSource);
    return withLegacyMigrationCompatibility(dataSource, () => showMigrations());
  };

  return dataSource;
}
