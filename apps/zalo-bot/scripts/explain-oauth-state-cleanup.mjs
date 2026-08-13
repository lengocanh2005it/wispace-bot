import pg from 'pg';

const pool = new pg.Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT ?? 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl:
    process.env.DB_SSL === 'true'
      ? { rejectUnauthorized: true, ca: process.env.DB_SSL_CA || undefined }
      : undefined,
});

const client = await pool.connect();

try {
  const size = await client.query(
    "SELECT c.reltuples::bigint AS estimated_rows FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'zalo_oauth_states'",
  );
  const indexes = await client.query(
    "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'zalo_oauth_states'",
  );
  const plan = await client.query(
    [
      'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)',
      'SELECT "state" FROM "zalo_oauth_states"',
      'WHERE "created_at" < NOW() - INTERVAL \'10 minutes\'',
    ].join('\n'),
  );

  const estimatedRows = Number(size.rows[0]?.estimated_rows ?? 0);
  const planJson = plan.rows[0]?.['QUERY PLAN']?.[0];
  const planText = JSON.stringify(planJson);
  const indexName = 'idx_zalo_oauth_states_created_at';
  const indexExists = indexes.rows.some((row) => row.indexname === indexName);
  const indexUsed = planText.includes(indexName);
  const expectedRowsForIndex = Number(
    process.env.EXPLAIN_EXPECT_INDEX_ROWS ?? 1000,
  );

  console.log('estimated_rows=' + estimatedRows);
  console.log('index_exists=' + indexExists);
  console.log('index_used=' + indexUsed);
  console.log(JSON.stringify(planJson, null, 2));

  if (!indexExists) {
    throw new Error('Missing ' + indexName);
  }
  if (estimatedRows >= expectedRowsForIndex && !indexUsed) {
    throw new Error(
      'Expected ' +
        indexName +
        ' in the plan for an estimated ' +
        estimatedRows +
        ' rows',
    );
  }
} finally {
  client.release();
  await pool.end();
}
