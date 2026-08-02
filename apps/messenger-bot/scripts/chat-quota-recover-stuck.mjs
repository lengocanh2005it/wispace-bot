import pg from 'pg';

function parseArgs(argv) {
  const args = {
    dryRun: false,
  };

  for (const arg of argv) {
    if (arg === '--dry-run') {
      args.dryRun = true;
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
  console.log(`Usage: npm run chat-quota:recover-stuck -- [options]

Refund + release messenger_chat_idempotency rows stuck in status=reserved
past CHAT_IDEMPOTENCY_STUCK_RESERVED_MS (default 10 minutes).

Options:
  --dry-run   List stuck keys only; do not refund/delete
  -h, --help  Show this help
`);
}

function readStuckReservedMs() {
  const raw = process.env.CHAT_IDEMPOTENCY_STUCK_RESERVED_MS?.trim();
  if (!raw) {
    return 600_000;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      'CHAT_IDEMPOTENCY_STUCK_RESERVED_MS must be a positive number in .env',
    );
  }

  return Math.floor(value);
}

const args = parseArgs(process.argv.slice(2));
const stuckMs = readStuckReservedMs();
const stuckBefore = new Date(Date.now() - stuckMs);

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
  const stuckResult = await client.query(
    `
      SELECT
        idempotency_key,
        psid,
        user_id,
        usage_date,
        reserved_at
      FROM messenger_chat_idempotency
      WHERE status = 'reserved' AND reserved_at < $1
      ORDER BY reserved_at ASC
    `,
    [stuckBefore],
  );

  if (args.dryRun) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          stuckReservedMs: stuckMs,
          stuckBefore: stuckBefore.toISOString(),
          count: stuckResult.rows.length,
          stuck: stuckResult.rows,
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  const recovered = [];

  for (const row of stuckResult.rows) {
    await client.query('BEGIN');

    try {
      const refundResult = await client.query(
        `
          UPDATE messenger_chat_idempotency
          SET status = 'refunded'
          WHERE idempotency_key = $1 AND status = 'reserved'
          RETURNING idempotency_key
        `,
        [row.idempotency_key],
      );

      if (!refundResult.rows[0]) {
        await client.query('ROLLBACK');
        continue;
      }

      await client.query(
        `
          UPDATE messenger_chat_daily_usage
          SET
            free_form_count = GREATEST(free_form_count - 1, 0),
            updated_at = now()
          WHERE psid = $1 AND usage_date = $2::date
        `,
        [row.psid, row.usage_date],
      );

      await client.query(
        `
          DELETE FROM messenger_chat_idempotency
          WHERE idempotency_key = $1
        `,
        [row.idempotency_key],
      );

      await client.query('COMMIT');
      recovered.push({
        idempotencyKey: row.idempotency_key,
        psid: row.psid,
        userId: row.user_id,
        usageDate: row.usage_date,
        reservedAt: row.reserved_at,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }

  console.log(
    JSON.stringify(
      {
        stuckReservedMs: stuckMs,
        stuckBefore: stuckBefore.toISOString(),
        recoveredCount: recovered.length,
        recovered,
        note: 'User can retry same message.mid; reserve on next webhook flush will run LLM again.',
      },
      null,
      2,
    ),
  );
} finally {
  client.release();
  await pool.end();
}
