import 'reflect-metadata';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Real-Postgres shape pinning for #754: TypeORM's Postgres runner returns
 * `[rows, rowCount]` for UPDATE and DELETE (even matching zero rows) and a
 * flat row array for everything else — including INSERT … ON CONFLICT DO
 * UPDATE, whose command tag stays INSERT. Asserts the shape the shared
 * `extractQueryRows` helper depends on, using the database rather than a mock.
 *
 * Usage: node scripts/query-returning-shape-smoke.mjs
 * Requires NODE_ENV=test + a loopback PostgreSQL (DB_* env, same contract as
 * database-bootstrap-smoke). Creates and drops its own throwaway table.
 */

const require = createRequire(import.meta.url);
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { DataSource } = require('typeorm');
const { extractQueryRows } = require('@wispace/bot-common');

for (const key of ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME']) {
  if (!process.env[key]?.trim()) {
    throw new Error(`query-returning shape smoke requires ${key}`);
  }
}
if (
  process.env.NODE_ENV !== 'test' ||
  !['127.0.0.1', 'localhost', '::1'].includes(
    process.env.DB_HOST.trim().toLowerCase(),
  )
) {
  throw new Error(
    'query-returning shape smoke requires NODE_ENV=test and a loopback DB_HOST',
  );
}

const TABLE = 'query_returning_shape_smoke';
const dataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: false,
  logging: false,
});

function assertShape(label, raw, expectedRows) {
  const rows = extractQueryRows(raw);
  const pass =
    rows.length === expectedRows.length &&
    expectedRows.every((row, i) => {
      const got = rows[i];
      return (
        typeof got === 'object' &&
        got !== null &&
        Object.keys(row).every((k) => got[k] === row[k])
      );
    });
  if (!pass) {
    throw new Error(
      `${label}: expected rows ${JSON.stringify(expectedRows)}, helper returned ${JSON.stringify(rows)} (raw was ${JSON.stringify(raw)})`,
    );
  }
  console.log(`  ok: ${label}`);
}

try {
  await dataSource.initialize();
  await dataSource.query(`DROP TABLE IF EXISTS "${TABLE}"`);
  await dataSource.query(
    `CREATE TABLE "${TABLE}" (id int primary key, tok text)`,
  );

  // INSERT — flat row array.
  const insertRaw = await dataSource.query(
    `INSERT INTO "${TABLE}" (id, tok) VALUES (1, 'a') RETURNING id, tok`,
  );
  assertShape('INSERT … RETURNING (flat rows)', insertRaw, [
    { id: 1, tok: 'a' },
  ]);

  // UPDATE matching 1 row — tuple.
  const updateRaw = await dataSource.query(
    `UPDATE "${TABLE}" SET tok = 'b' WHERE id = 1 RETURNING id, tok`,
  );
  assertShape('UPDATE … RETURNING (match 1, tuple)', updateRaw, [
    { id: 1, tok: 'b' },
  ]);

  // UPDATE matching 0 rows — tuple with an empty row array (the bug: length 2
  // made the "nothing matched" guard unreachable).
  const updateZeroRaw = await dataSource.query(
    `UPDATE "${TABLE}" SET tok = 'c' WHERE id = 999 RETURNING id, tok`,
  );
  assertShape('UPDATE … RETURNING (match 0, [[], 0])', updateZeroRaw, []);

  // INSERT … ON CONFLICT DO UPDATE (update path) — tag stays INSERT → flat.
  const conflictRaw = await dataSource.query(
    `INSERT INTO "${TABLE}" (id, tok) VALUES (1, 'x')
     ON CONFLICT (id) DO UPDATE SET tok = EXCLUDED.tok
     RETURNING id, tok`,
  );
  assertShape(
    'INSERT … ON CONFLICT DO UPDATE … RETURNING (flat rows)',
    conflictRaw,
    [{ id: 1, tok: 'x' }],
  );

  // INSERT … ON CONFLICT DO UPDATE WHERE false — flat empty array, NOT a tuple.
  const conflictZeroRaw = await dataSource.query(
    `INSERT INTO "${TABLE}" (id, tok) VALUES (1, 'y')
     ON CONFLICT (id) DO UPDATE SET tok = EXCLUDED.tok
     WHERE "${TABLE}".tok = 'impossible'
     RETURNING id, tok`,
  );
  assertShape(
    'INSERT … ON CONFLICT DO UPDATE WHERE false … RETURNING (flat [])',
    conflictZeroRaw,
    [],
  );

  // DELETE matching 1 row — tuple.
  const deleteRaw = await dataSource.query(
    `DELETE FROM "${TABLE}" WHERE id = 1 RETURNING id`,
  );
  assertShape('DELETE … RETURNING (match 1, tuple)', deleteRaw, [{ id: 1 }]);

  // DELETE matching 0 rows — tuple with an empty row array.
  const deleteZeroRaw = await dataSource.query(
    `DELETE FROM "${TABLE}" WHERE id = 999 RETURNING id`,
  );
  assertShape('DELETE … RETURNING (match 0, [[], 0])', deleteZeroRaw, []);

  console.log('query-returning shape smoke: all statement shapes pinned');
} finally {
  try {
    await dataSource.query(`DROP TABLE IF EXISTS "${TABLE}"`);
  } catch {
    // best effort cleanup
  }
  if (dataSource.isInitialized) await dataSource.destroy();
}
