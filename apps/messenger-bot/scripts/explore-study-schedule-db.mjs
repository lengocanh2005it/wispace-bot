import { createPool } from './_db.mjs';

const pool = createPool();

const client = await pool.connect();

try {
  const keywords = [
    'schedule',
    'study',
    'session',
    'messenger',
    'reminder',
    'calendar',
    'class',
    'lesson',
  ];
  const tables = await client.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name
  `);

  console.log('=== Tables matching study/messenger keywords ===');
  for (const row of tables.rows) {
    const name = row.table_name.toLowerCase();
    if (keywords.some((k) => name.includes(k))) {
      console.log(`- ${row.table_name}`);
    }
  }

  for (const tableName of [
    'user_messenger_mappings',
    'study_reminder_jobs',
    'messenger_message_logs',
  ]) {
    const exists = await client.query(`SELECT to_regclass($1) AS reg`, [
      `public.${tableName}`,
    ]);
    if (!exists.rows[0]?.reg) {
      console.log(`\n${tableName}: NOT FOUND`);
      continue;
    }

    const columns = await client.query(
      `
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position
    `,
      [tableName],
    );
    const count = await client.query(
      `SELECT COUNT(*)::int AS count FROM "${tableName}"`,
    );

    console.log(`\n=== ${tableName} (${count.rows[0].count} rows) ===`);
    for (const col of columns.rows) {
      console.log(
        `  ${col.column_name}: ${col.data_type} nullable=${col.is_nullable}`,
      );
    }

    const sample = await client.query(
      `SELECT * FROM "${tableName}" ORDER BY 1 DESC LIMIT 3`,
    );
    console.log('Sample:', JSON.stringify(sample.rows, null, 2));
  }

  const scheduleTables = tables.rows
    .map((r) => r.table_name)
    .filter((name) =>
      /schedule|session|lesson|class|calendar|study/i.test(name),
    );

  for (const tableName of scheduleTables) {
    if (
      [
        'user_messenger_mappings',
        'study_reminder_jobs',
        'messenger_message_logs',
      ].includes(tableName)
    ) {
      continue;
    }

    const columns = await client.query(
      `
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position
    `,
      [tableName],
    );
    const count = await client.query(
      `SELECT COUNT(*)::int AS count FROM "${tableName}"`,
    );

    console.log(
      `\n=== Candidate schedule table: ${tableName} (${count.rows[0].count} rows) ===`,
    );
    for (const col of columns.rows) {
      console.log(`  ${col.column_name}: ${col.data_type}`);
    }

    const sample = await client.query(
      `SELECT * FROM "${tableName}" ORDER BY 1 DESC LIMIT 2`,
    );
    console.log('Sample:', JSON.stringify(sample.rows, null, 2));
  }
} finally {
  client.release();
  await pool.end();
}
