/**
 * Normalizes a raw TypeORM `query()` result to a flat row array.
 *
 * TypeORM's Postgres query runner branches on the command tag: UPDATE and
 * DELETE (even matching zero rows) return `[rows, rowCount]`, while
 * everything else — SELECT, INSERT, `INSERT … ON CONFLICT DO UPDATE`
 * (tag stays INSERT) — returns the rows array directly.
 */
export function extractQueryRows<T>(result: unknown): T[] {
  if (
    Array.isArray(result) &&
    result.length === 2 &&
    Array.isArray(result[0])
  ) {
    return result[0] as T[];
  }
  return (Array.isArray(result) ? result : []) as T[];
}
