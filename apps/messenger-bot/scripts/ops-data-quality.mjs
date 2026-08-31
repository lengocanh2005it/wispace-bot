import { createRequire } from 'node:module';
import { createPool } from './_db.mjs';
import { parseArgs } from './_args.mjs';

const require = createRequire(import.meta.url);
const {
  DataQualityService,
  TypeormDataQualityRepository,
  readDataQualityConfig,
} = require('@wispace/ops-health');
const { getPostgresSsl } = require('@wispace/database');

const HELP = `Usage: npm run ops:data-quality -- [options]

Run the bounded, read-only scheduled data-quality checks.

Options:
  --json                Print stable machine-readable JSON
  -h, --help            Show this help
`;

class PoolDataQualityDatabase {
  constructor(pool) {
    this.pool = pool;
  }

  async withReadOnly(timeoutMs, operation) {
    const client = await this.pool.connect();
    let inTransaction = false;
    try {
      await client.query('BEGIN');
      inTransaction = true;
      await client.query('SET TRANSACTION READ ONLY');
      await client.query(`SELECT set_config('statement_timeout', $1, true)`, [
        `${Math.max(1, Math.floor(timeoutMs))}ms`,
      ]);
      const query = {
        query: async (sql, parameters = []) => {
          const result = await client.query(sql, [...parameters]);
          return result.rows;
        },
      };
      const result = await operation(query);
      await client.query('COMMIT');
      inTransaction = false;
      return result;
    } catch (error) {
      if (inTransaction) {
        await client.query('ROLLBACK').catch(() => undefined);
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

const args = parseArgs(process.argv.slice(2), {
  defaults: { json: false },
  help: HELP,
  handle: (parsed, arg) => {
    if (arg === '--json') {
      parsed.json = true;
      return true;
    }
    return false;
  },
});

let pool;
const lock = {
  async withLock(lockId, operation) {
    const client = await pool.connect();
    let acquired = false;
    try {
      const result = await client.query(
        'SELECT pg_try_advisory_lock($1::bigint) AS acquired',
        [lockId],
      );
      acquired = result.rows[0]?.acquired === true;
      if (!acquired) return null;
      return await operation();
    } finally {
      if (acquired) {
        await client.query('SELECT pg_advisory_unlock($1::bigint)', [lockId]);
      }
      client.release();
    }
  },
};

function printHuman(result) {
  console.log(
    `DATA_QUALITY_${result.status.toUpperCase()} checks=${result.checks.length} durationMs=${result.durationMs}`,
  );
  if (result.status === 'skipped') {
    console.log('SKIPPED reason=advisory_lock_held');
    return;
  }
  for (const check of result.checks) {
    const samples =
      check.sampleKeys.length > 0 ? check.sampleKeys.join(',') : 'none';
    console.log(
      `${check.status.toUpperCase()} ${check.check} count=${check.count} baseline=${check.baseline ?? 'none'} threshold=${check.threshold ?? 'none'} reason=${check.reason ?? 'none'} samples=${samples}`,
    );
  }
}

let exitCode = 0;
try {
  pool = createPool(process.env, {}, getPostgresSsl(process.env));
  const config = readDataQualityConfig((key) => process.env[key]);
  const database = new PoolDataQualityDatabase(pool);
  const service = new DataQualityService(
    new TypeormDataQualityRepository(database),
    lock,
    config,
  );
  const result = await service.run();
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHuman(result);
  }
  exitCode = result.status === 'fail' ? 1 : 0;
} catch {
  console.error('DATA_QUALITY_ERROR query_failed');
  exitCode = 1;
} finally {
  await pool?.end();
}

process.exitCode = exitCode;
