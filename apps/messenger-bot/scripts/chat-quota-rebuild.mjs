import pg from 'pg';

function parseArgs(argv) {
  const args = {
    from: null,
    to: null,
    dailyLimit: null,
    dryRun: false,
  };

  for (const arg of argv) {
    if (arg.startsWith('--from=')) {
      args.from = arg.slice('--from='.length).trim();
    } else if (arg.startsWith('--to=')) {
      args.to = arg.slice('--to='.length).trim();
    } else if (arg.startsWith('--daily-limit=')) {
      const value = Number(arg.slice('--daily-limit='.length));
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error('--daily-limit must be a positive number');
      }
      args.dailyLimit = value;
    } else if (arg === '--dry-run') {
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
  console.log(`Usage: npm run chat-quota:rebuild -- [options]

Rebuild messenger_chat_daily_usage.free_form_count from messenger_chat_events.

Options:
  --from=YYYY-MM-DD     Start usage_date (inclusive). Default: today ICT
  --to=YYYY-MM-DD       End usage_date (inclusive). Default: same as --from
  --daily-limit=N       Override CHAT_FREE_FORM_DAILY_LIMIT (projection only)
  --dry-run             Print changes without writing
  -h, --help            Show this help
`);
}

function todayUsageDate(timezone, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function readPositiveNumber(key, fallback = null) {
  const raw = process.env[key]?.trim();
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${key} must be a positive number in .env`);
  }

  return value;
}

function replayEvents(events) {
  let used = 0;
  for (const event of events) {
    if (event.event_type === 'CHAT_QUOTA_RESERVED') {
      used += 1;
    } else if (event.event_type === 'CHAT_QUOTA_RELEASED') {
      used = Math.max(used - 1, 0);
    }
  }

  return used;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const timezone = process.env.CHAT_USAGE_TIMEZONE?.trim() ?? 'Asia/Ho_Chi_Minh';
  const today = todayUsageDate(timezone);
  const from = args.from ?? today;
  const to = args.to ?? from;
  const dailyLimit =
    args.dailyLimit ?? readPositiveNumber('CHAT_FREE_FORM_DAILY_LIMIT', 15);

  const client = new pg.Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl:
      process.env.DB_SSL === 'true'
        ? { rejectUnauthorized: true, ca: process.env.DB_SSL_CA || undefined }
        : false,
  });

  await client.connect();

  try {
    const pairs = await client.query(
      `
        SELECT DISTINCT aggregate_id AS psid, usage_date::text AS usage_date
        FROM messenger_chat_events
        WHERE usage_date >= $1::date AND usage_date <= $2::date
        ORDER BY usage_date, aggregate_id
      `,
      [from, to],
    );

    let updated = 0;
    for (const pair of pairs.rows) {
      const eventsResult = await client.query(
        `
          SELECT event_type
          FROM messenger_chat_events
          WHERE aggregate_id = $1 AND usage_date = $2::date
          ORDER BY occurred_at ASC, id ASC
        `,
        [pair.psid, pair.usage_date],
      );

      const used = replayEvents(eventsResult.rows);
      const capped = Math.min(used, dailyLimit);

      const current = await client.query(
        `
          SELECT free_form_count
          FROM messenger_chat_daily_usage
          WHERE psid = $1 AND usage_date = $2::date
        `,
        [pair.psid, pair.usage_date],
      );

      const before = current.rows[0]?.free_form_count ?? 0;
      if (before === capped) {
        continue;
      }

      console.log(
        `${args.dryRun ? '[dry-run] ' : ''}psid=${pair.psid} date=${pair.usage_date} ${before} -> ${capped} (raw=${used}, limit=${dailyLimit})`,
      );

      if (!args.dryRun) {
        await client.query(
          `
            INSERT INTO messenger_chat_daily_usage (psid, usage_date, free_form_count)
            VALUES ($1, $2::date, $3)
            ON CONFLICT (psid, usage_date)
            DO UPDATE SET
              free_form_count = EXCLUDED.free_form_count,
              updated_at = now()
          `,
          [pair.psid, pair.usage_date, capped],
        );
      }

      updated += 1;
    }

    console.log(
      `chat-quota:rebuild complete range=${from}..${to} pairs=${pairs.rows.length} changed=${updated}${args.dryRun ? ' (dry-run)' : ''}`,
    );
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
