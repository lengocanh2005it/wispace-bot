export const POSTGRES_WRITER_CHECK_QUERY =
  'SELECT pg_is_in_recovery() AS in_recovery';

export interface PostgresQueryable {
  query(query: string, parameters?: unknown[]): Promise<unknown>;
}

function isFalse(value: unknown): boolean {
  return value === false || value === 'f' || value === 0;
}

function hasWritablePrimaryResult(rows: unknown): boolean {
  if (!Array.isArray(rows)) return false;
  const first = rows[0];
  if (!first || typeof first !== 'object') return false;
  return isFalse((first as { in_recovery?: unknown }).in_recovery);
}

export async function assertPostgresWriter(
  client: PostgresQueryable,
): Promise<void> {
  const rows = await client.query(POSTGRES_WRITER_CHECK_QUERY);
  if (!hasWritablePrimaryResult(rows)) {
    throw new Error('PostgreSQL connection is not a writable primary');
  }
}

export async function isPostgresWriter(
  client: PostgresQueryable,
): Promise<boolean> {
  try {
    await assertPostgresWriter(client);
    return true;
  } catch {
    return false;
  }
}
