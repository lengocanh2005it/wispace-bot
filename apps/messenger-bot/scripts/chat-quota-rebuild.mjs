import pg from 'pg';
import { parseArgs } from './_args.mjs';

const HELP = `Usage: npm run chat-quota:rebuild -- [options]

Rebuild chat_daily_usage.free_form_count from chat_quota_events.

Options:
  --from=YYYY-MM-DD     Start usage_date (inclusive). Default: today ICT
  --to=YYYY-MM-DD       End usage_date (inclusive). Default: same as --from
  --daily-limit=N       Override CHAT_FREE_FORM_DAILY_LIMIT (projection only)
  --dry-run             Print changes without writing
  -h, --help            Show this help
`;

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
  const args = parseArgs(process.argv.slice(2), {
    defaults: { from: null, to: null, dailyLimit: null, dryRun: false },
    help: HELP,
    handle: (a, arg) => {
      if (arg.startsWith('--from=')) {
        a.from = arg.slice('--from='.length).trim();
        return true;
      }
      if (arg.startsWith('--to=')) {
        a.to = arg.slice('--to='.length).trim();
        return true;
      }
      if (arg.startsWith('--daily-limit=')) {
        const value = Number(arg.slice('--daily-limit='.length));
        if (!Number.isFinite(value) || value <= 0) {
          throw new Error('--daily-limit must be a positive number');
        }
        a.dailyLimit = value;
        return true;
      }
      if (arg === '--dry-run') {
        a.dryRun = true;
        return true;
      }
      return false;
    },
  });
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
        SELECT DISTINCT aggregate_id AS external_user_id, usage_date::text AS usage_date
        FROM chat_quota_events
        WHERE platform = 'messenger'
          AND usage_date >= $1::date AND usage_date <= $2::date
        ORDER BY usage_date, aggregate_id
      `,
      [from, to],
    );

    let updated = 0;
    for (const pair of pairs.rows) {
      const eventsResult = await client.query(
        `
          SELECT event_type
          FROM chat_quota_events
          WHERE platform = 'messenger'
            AND aggregate_id = $1 AND usage_date = $2::date
          ORDER BY occurred_at ASC, id ASC
        `,
        [pair.external_user_id, pair.usage_date],
      );

      const used = replayEvents(eventsResult.rows);
      const capped = Math.min(used, dailyLimit);

      const current = await client.query(
        `
          SELECT free_form_count
          FROM chat_daily_usage
          WHERE platform = 'messenger'
            AND external_user_id = $1 AND usage_date = $2::date
        `,
        [pair.external_user_id, pair.usage_date],
      );

      const before = current.rows[0]?.free_form_count ?? 0;
      if (before === capped) {
        continue;
      }

      console.log(
        `${args.dryRun ? '[dry-run] ' : ''}externalUserId=${pair.external_user_id} date=${pair.usage_date} ${before} -> ${capped} (raw=${used}, limit=${dailyLimit})`,
      );

      if (!args.dryRun) {
        await client.query(
          `
            INSERT INTO chat_daily_usage (platform, external_user_id, usage_date, free_form_count)
            VALUES ('messenger', $1, $2::date, $3)
            ON CONFLICT (platform, external_user_id, usage_date)
            DO UPDATE SET
              free_form_count = EXCLUDED.free_form_count,
              updated_at = now()
          `,
          [pair.external_user_id, pair.usage_date, capped],
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
