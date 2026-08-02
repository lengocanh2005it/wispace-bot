import pg from 'pg';

function parseArgs(argv) {
  const args = {
    status: null,
    failed: false,
    stuck: false,
    summary: false,
    hours: 24,
    stuckMinutes: 10,
    limit: 100,
    psid: null,
    userId: null,
  };

  for (const arg of argv) {
    if (arg.startsWith('--status=')) {
      args.status = arg.slice('--status='.length).trim();
    } else if (arg.startsWith('--hours=')) {
      args.hours = readPositiveNumber(arg.slice('--hours='.length), '--hours');
    } else if (arg.startsWith('--stuck-minutes=')) {
      args.stuckMinutes = readPositiveNumber(
        arg.slice('--stuck-minutes='.length),
        '--stuck-minutes',
      );
    } else if (arg.startsWith('--limit=')) {
      args.limit = readPositiveNumber(arg.slice('--limit='.length), '--limit');
    } else if (arg.startsWith('--psid=')) {
      args.psid = arg.slice('--psid='.length).trim();
    } else if (arg.startsWith('--user-id=')) {
      args.userId = readPositiveNumber(
        arg.slice('--user-id='.length),
        '--user-id',
      );
    } else if (arg === '--failed') {
      args.failed = true;
    } else if (arg === '--stuck') {
      args.stuck = true;
    } else if (arg === '--summary') {
      args.summary = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function readPositiveNumber(raw, label) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number`);
  }

  return Math.floor(value);
}

function printHelp() {
  console.log(`Usage: npm run study-reminder:jobs -- [options]

Options:
  --status=<status>       Filter by status (pending|processing|sent|failed|cancelled)
  --failed                Terminal failed only (retry_count >= max_retries)
  --stuck                 Processing jobs older than --stuck-minutes (default 10)
  --summary               JSON summary counts only (S1 ops)
  --hours=<n>             Lookback for --failed (default 24)
  --stuck-minutes=<n>     Threshold for --stuck (default 10)
  --limit=<n>             Max rows (default 100)
  --psid=<psid>           Filter by PSID
  --user-id=<number>      Filter by user_id
  -h, --help              Show this help
`);
}

const args = parseArgs(process.argv.slice(2));

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

try {
  const since = new Date(Date.now() - args.hours * 60 * 60 * 1000);
  const stuckBefore = new Date(Date.now() - args.stuckMinutes * 60 * 1000);
  const filters = [];
  const params = [];
  let paramIndex = 1;

  const addFilter = (clause, value) => {
    filters.push(clause.replace(/\$(\?)/g, () => `$${paramIndex++}`));
    params.push(value);
  };

  if (args.psid) {
    addFilter('psid = $?::varchar', args.psid);
  }

  if (args.userId) {
    addFilter('user_id = $?::int', args.userId);
  }

  if (args.status) {
    addFilter('status = $?::varchar', args.status);
  }

  if (args.failed) {
    filters.push(`status = 'failed'`);
    filters.push('retry_count >= max_retries');
    addFilter('updated_at >= $?::timestamptz', since);
  }

  if (args.stuck) {
    filters.push(`status = 'processing'`);
    addFilter('updated_at <= $?::timestamptz', stuckBefore);
  }

  const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  if (args.summary) {
    const countsResult = await pool.query(
      `
        SELECT status, COUNT(*)::int AS count
        FROM study_reminder_jobs
        ${whereClause}
        GROUP BY status
        ORDER BY status ASC
      `,
      params,
    );

    const terminalFailedResult = await pool.query(
      `
        SELECT COUNT(*)::int AS count
        FROM study_reminder_jobs
        WHERE status = 'failed'
          AND retry_count >= max_retries
          AND updated_at >= $1::timestamptz
          AND ($2::varchar IS NULL OR psid = $2)
          AND ($3::int IS NULL OR user_id = $3)
      `,
      [since, args.psid, args.userId],
    );

    const stuckResult = await pool.query(
      `
        SELECT COUNT(*)::int AS count
        FROM study_reminder_jobs
        WHERE status = 'processing'
          AND updated_at <= $1::timestamptz
          AND ($2::varchar IS NULL OR psid = $2)
          AND ($3::int IS NULL OR user_id = $3)
      `,
      [stuckBefore, args.psid, args.userId],
    );

    console.log(
      JSON.stringify(
        {
          filters: {
            psid: args.psid,
            userId: args.userId,
            failedHours: args.hours,
            stuckMinutes: args.stuckMinutes,
          },
          countsByStatus: Object.fromEntries(
            countsResult.rows.map((row) => [row.status, row.count]),
          ),
          terminalFailedSince: terminalFailedResult.rows[0]?.count ?? 0,
          stuckProcessing: stuckResult.rows[0]?.count ?? 0,
          runbook: {
            listFailed: 'npm run study-reminder:jobs -- --failed',
            listStuck: 'npm run study-reminder:jobs -- --stuck',
            dailyHealth: 'npm run ops:health',
          },
        },
        null,
        2,
      ),
    );
  } else {
    const result = await pool.query(
      `
        SELECT
          id,
          psid,
          user_id,
          session_key,
          scheduled_at,
          remind_at,
          topic,
          status,
          retry_count,
          max_retries,
          next_retry_at,
          last_error,
          sent_at,
          updated_at
        FROM study_reminder_jobs
        ${whereClause}
        ORDER BY updated_at DESC
        LIMIT ${args.limit}
      `,
      params,
    );

    console.log(JSON.stringify(result.rows, null, 2));
  }
} finally {
  await pool.end();
}
