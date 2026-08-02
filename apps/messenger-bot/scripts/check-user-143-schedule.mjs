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

const userId = 143;

const mapping = await pool.query(
  `
  SELECT id, user_id, psid, status, topic, cadence, updated_at
  FROM user_messenger_mappings
  WHERE user_id = $1 AND status = 'ACTIVE'
  ORDER BY id DESC
  `,
  [userId],
);
console.log('\n=== Mappings user_id=143 ===');
console.log(JSON.stringify(mapping.rows, null, 2));

for (const row of mapping.rows) {
  if (!row.psid) continue;

  const url = process.env.WISPACE_API_USER_CALENDAR_URL;
  try {
    const res = await fetch(url, {
      headers: { 'x-psid': row.psid, Accept: 'application/json' },
    });
    const body = await res.text();
    console.log(`\n=== UserCalendar API psid=${row.psid} HTTP ${res.status} ===`);
    console.log(body.slice(0, 2000));
  } catch (error) {
    console.log(`API error psid=${row.psid}:`, error);
  }
}

const dbCal = await pool.query(
  `
  SELECT "Id", "UserId", "EventDate", "Time", "CreatedAt"
  FROM "UserCalendars"
  WHERE "UserId" = $1
  ORDER BY "EventDate" ASC
  `,
  [userId],
);
console.log('\n=== UserCalendars DB user_id=143 (all rows) ===');
console.log(JSON.stringify(dbCal.rows, null, 2));

const upcomingDb = await pool.query(
  `
  SELECT "Id", "EventDate", "Time"
  FROM "UserCalendars"
  WHERE "UserId" = $1
    AND "EventDate" > NOW() - INTERVAL '1 hour'
  ORDER BY "EventDate" ASC
  LIMIT 20
  `,
  [userId],
);
console.log('\n=== UserCalendars upcoming (EventDate > now-1h) ===');
console.log(JSON.stringify(upcomingDb.rows, null, 2));

const jobs = await pool.query(
  `
  SELECT id, psid, session_key, scheduled_at, remind_at, status
  FROM study_reminder_jobs
  WHERE user_id = $1 OR psid IN (SELECT psid FROM user_messenger_mappings WHERE user_id = $1)
  ORDER BY scheduled_at ASC
  LIMIT 20
  `,
  [userId],
);
console.log('\n=== study_reminder_jobs ===');
console.log(JSON.stringify(jobs.rows, null, 2));

await pool.end();
