import pg from 'pg';

function parseArgs(argv) {
  const args = {
    dryRun: false,
    retentionDays: null,
  };

  for (const arg of argv) {
    if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg.startsWith('--retention-days=')) {
      const value = Number(arg.slice('--retention-days='.length));
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error('--retention-days must be a positive number');
      }
      args.retentionDays = Math.floor(value);
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage: npm run chat-quota:cleanup -- [options]

Delete terminal messenger_chat_idempotency rows (completed/refunded) older than
CHAT_IDEMPOTENCY_RETENTION_DAYS (default 90). Does not delete status=reserved.

Options:
  --dry-run                 List rows that would be deleted
  --retention-days=<n>      Override env retention window
  -h, --help                Show this help
`);
}

function readRetentionDays(override) {
  if (override !== null) {
    return override;
  }

  const raw = process.env.CHAT_IDEMPOTENCY_RETENTION_DAYS?.trim();
  if (!raw) {
    return 90;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      'CHAT_IDEMPOTENCY_RETENTION_DAYS must be a positive number in .env',
    );
  }

  return Math.floor(value);
}

const args = parseArgs(process.argv.slice(2));
const retentionDays = readRetentionDays(args.retentionDays);

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
  const preview = await pool.query(
    `
      SELECT
        status,
        COUNT(*)::int AS count,
        MIN(reserved_at) AS oldest_reserved_at,
        MAX(reserved_at) AS newest_reserved_at
      FROM messenger_chat_idempotency
      WHERE status IN ('completed', 'refunded')
        AND reserved_at < NOW() - ($1::int * INTERVAL '1 day')
      GROUP BY status
      ORDER BY status ASC
    `,
    [retentionDays],
  );

  const totalEligible = preview.rows.reduce((sum, row) => sum + row.count, 0);

  if (args.dryRun) {
    const sample = await pool.query(
      `
        SELECT idempotency_key, psid, status, reserved_at
        FROM messenger_chat_idempotency
        WHERE status IN ('completed', 'refunded')
          AND reserved_at < NOW() - ($1::int * INTERVAL '1 day')
        ORDER BY reserved_at ASC
        LIMIT 20
      `,
      [retentionDays],
    );

    console.log(
      JSON.stringify(
        {
          dryRun: true,
          retentionDays,
          eligibleCount: totalEligible,
          byStatus: preview.rows,
          sample: sample.rows,
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  const deleted = await pool.query(
    `
      DELETE FROM messenger_chat_idempotency
      WHERE status IN ('completed', 'refunded')
        AND reserved_at < NOW() - ($1::int * INTERVAL '1 day')
      RETURNING idempotency_key, psid, status, reserved_at
    `,
    [retentionDays],
  );

  console.log(
    JSON.stringify(
      {
        retentionDays,
        deletedCount: deleted.rowCount,
        byStatusBeforeDelete: preview.rows,
        note: 'status=reserved rows are never deleted by this cleanup.',
      },
      null,
      2,
    ),
  );
} finally {
  await pool.end();
}
