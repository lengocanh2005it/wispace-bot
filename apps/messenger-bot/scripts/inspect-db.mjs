import { createPool } from './_db.mjs';

const pool = createPool();

const client = await pool.connect();

try {
  const tables = await client.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name
  `);

  console.log('Tables:');
  for (const row of tables.rows) {
    console.log(`- ${row.table_name}`);
  }

  for (const row of tables.rows.slice(0, 20)) {
    const columns = await client.query(
      `
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position
    `,
      [row.table_name],
    );

    console.log(`\n${row.table_name}:`);
    for (const col of columns.rows) {
      console.log(`  ${col.column_name}: ${col.data_type}`);
    }
  }
} finally {
  client.release();
  await pool.end();
}
