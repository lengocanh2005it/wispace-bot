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

const cols = await pool.query(`
  SELECT table_name, column_name, data_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name IN ('Users', 'user_profiles', 'user_messenger_mappings')
  ORDER BY table_name, ordinal_position
`);
console.log('Columns:', JSON.stringify(cols.rows, null, 2));

const sample = await pool.query(`
  SELECT u."Id", u."DisplayName", u."Username", m.user_id, m.psid
  FROM "Users" u
  JOIN user_messenger_mappings m ON m.user_id = u."Id"
  WHERE m.status = 'ACTIVE' AND m.psid IS NOT NULL
  LIMIT 10
`);
console.log('Sample:', JSON.stringify(sample.rows, null, 2));

await pool.end();
