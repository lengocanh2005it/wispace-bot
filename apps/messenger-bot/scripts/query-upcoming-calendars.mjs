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

const result = await pool.query(`
  SELECT
    m.psid,
    m.user_id,
    uc."Id" AS calendar_id,
    uc."EventDate",
    uc."Time"
  FROM user_messenger_mappings m
  JOIN "UserCalendars" uc ON uc."UserId" = m.user_id
  WHERE m.status = 'ACTIVE'
    AND m.psid IS NOT NULL
    AND uc."EventDate" >= NOW() - INTERVAL '1 day'
  ORDER BY uc."EventDate"
  LIMIT 20
`);

console.log(JSON.stringify(result.rows, null, 2));
await pool.end();
