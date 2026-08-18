import { createPool } from './_db.mjs';
import { parseArgs } from './_args.mjs';

const HELP = `Usage: npm run chat-quota:status -- [options]

Options:
  --psid=<psid>         Filter by Messenger PSID
  --user-id=<number>    Filter by WISPACE user_id
  --date=YYYY-MM-DD     Usage date (ICT calendar day). Default: today per CHAT_USAGE_TIMEZONE
  --ops                 Fleet-wide I1 ops summary (ignore psid/user filters)
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

function readEnabledFlag() {
  const raw = process.env.CHAT_RATE_LIMIT_ENABLED?.trim().toLowerCase();
  if (!raw) {
    return false;
  }

  return raw === 'true' || raw === '1' || raw === 'yes';
}

function readWhitelist() {
  const raw = process.env.CHAT_RATE_LIMIT_WHITELIST_PSIDS?.trim();
  if (!raw) {
    return [];
  }

  return raw
    .split(',')
    .map((psid) => psid.trim())
    .filter((psid) => psid.length > 0);
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

function readRetentionDays() {
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

const args = parseArgs(process.argv.slice(2), {
  defaults: { psid: null, userId: null, date: null, ops: false },
  help: HELP,
  handle: (a, arg) => {
    if (arg.startsWith('--psid=')) {
      a.psid = arg.slice('--psid='.length).trim();
      return true;
    }
    if (arg.startsWith('--user-id=')) {
      const value = Number(arg.slice('--user-id='.length));
      if (!Number.isFinite(value)) {
        throw new Error('--user-id must be a number');
      }
      a.userId = value;
      return true;
    }
    if (arg.startsWith('--date=')) {
      a.date = arg.slice('--date='.length).trim();
      return true;
    }
    if (arg === '--ops') {
      a.ops = true;
      return true;
    }
    return false;
  },
});
const timezone = process.env.CHAT_USAGE_TIMEZONE?.trim() ?? 'Asia/Ho_Chi_Minh';
const usageDate = args.date ?? todayUsageDate(timezone);
const dailyLimit = readPositiveNumber('CHAT_FREE_FORM_DAILY_LIMIT', 15);
const burstPerMinute = readPositiveNumber('CHAT_BURST_PER_MINUTE', 3);
const remainingHintThreshold = readPositiveNumber(
  'CHAT_QUOTA_REMAINING_HINT_THRESHOLD',
  3,
);
const stuckReservedMs = readStuckReservedMs();
const retentionDays = readRetentionDays();
const stuckBefore = new Date(Date.now() - stuckReservedMs);

const pool = createPool();

try {
  if (args.ops) {
    const denySince = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [
      stuckReservedCount,
      usersAtLimit,
      denyLogs24h,
      idempotencyFleet,
      dailyUsageToday,
    ] = await Promise.all([
      pool.query(
        `
          SELECT COUNT(*)::int AS count
          FROM chat_idempotency
          WHERE status = 'reserved' AND reserved_at < $1::timestamptz
        `,
        [stuckBefore],
      ),
      pool.query(
        `
          SELECT COUNT(*)::int AS count
          FROM chat_daily_usage
          WHERE usage_date = $1::date
            AND free_form_count >= $2::int
        `,
        [usageDate, dailyLimit],
      ),
      pool.query(
        `
          SELECT COUNT(*)::int AS count
          FROM message_logs
          WHERE message_type = 'CHAT_QUOTA_DENIED'
            AND created_at >= $1::timestamptz
        `,
        [denySince],
      ),
      pool.query(
        `
          SELECT status, COUNT(*)::int AS count
          FROM chat_idempotency
          WHERE usage_date = $1::date
          GROUP BY status
          ORDER BY status ASC
        `,
        [usageDate],
      ),
      pool.query(
        `
          SELECT
            COUNT(*)::int AS users_with_usage,
            COALESCE(SUM(free_form_count), 0)::int AS total_messages
          FROM chat_daily_usage
          WHERE usage_date = $1::date
        `,
        [usageDate],
      ),
    ]);

    console.log(
      JSON.stringify(
        {
          mode: 'ops-summary',
          generatedAt: new Date().toISOString(),
          usageDate,
          config: {
            enabled: readEnabledFlag(),
            dailyLimit,
            burstPerMinute,
            stuckReservedMs,
            retentionDays,
            timezone,
          },
          metrics: {
            stuckReserved: stuckReservedCount.rows[0]?.count ?? 0,
            usersAtDailyLimit: usersAtLimit.rows[0]?.count ?? 0,
            denyLogs24h: denyLogs24h.rows[0]?.count ?? 0,
            usersWithUsageToday: dailyUsageToday.rows[0]?.users_with_usage ?? 0,
            totalMessagesToday: dailyUsageToday.rows[0]?.total_messages ?? 0,
            idempotencyByStatus: Object.fromEntries(
              idempotencyFleet.rows.map((row) => [row.status, row.count]),
            ),
          },
          logGrepHints: [
            'CHAT_QUOTA_DENY',
            'CHAT_QUOTA_REFUND',
            'CHAT_QUOTA_RECOVERED',
            'OPS_HEALTH_ALERT',
          ],
          runbook: {
            dailyHealth: 'npm run ops:health',
            recoverStuck: 'npm run chat-quota:recover-stuck -- --dry-run',
            cleanup: 'npm run chat-quota:cleanup -- --dry-run',
          },
        },
        null,
        2,
      ),
    );
  } else {
    const dailyUsageResult = await pool.query(
      `
      SELECT
        id,
        external_user_id AS psid,
        user_id,
        usage_date,
        free_form_count,
        created_at,
        updated_at
      FROM chat_daily_usage
      WHERE ($1::varchar IS NULL OR external_user_id = $1)
        AND ($2::int IS NULL OR user_id = $2)
        AND usage_date = $3::date
      ORDER BY external_user_id ASC
    `,
      [args.psid, args.userId, usageDate],
    );

    const idempotencyResult = await pool.query(
      `
      SELECT
        idempotency_key,
        external_user_id AS psid,
        user_id,
        usage_date,
        status,
        reserved_at
      FROM chat_idempotency
      WHERE ($1::varchar IS NULL OR external_user_id = $1)
        AND ($2::int IS NULL OR user_id = $2)
        AND usage_date = $3::date
      ORDER BY reserved_at DESC
      LIMIT 100
    `,
      [args.psid, args.userId, usageDate],
    );

    const burstResult = await pool.query(
      `
      SELECT COUNT(*)::int AS recent_count
      FROM chat_idempotency
      WHERE ($1::varchar IS NULL OR external_user_id = $1)
        AND reserved_at > NOW() - INTERVAL '1 minute'
        AND status IN ('reserved', 'completed')
    `,
      [args.psid],
    );

    const stuckResult = await pool.query(
      `
      SELECT
        idempotency_key,
        external_user_id AS psid,
        user_id,
        usage_date,
        reserved_at
      FROM chat_idempotency
      WHERE status = 'reserved'
        AND reserved_at < $1
        AND ($2::varchar IS NULL OR external_user_id = $2)
      ORDER BY reserved_at ASC
      LIMIT 50
    `,
      [stuckBefore, args.psid],
    );

    const idempotencyStatsResult = await pool.query(
      `
      SELECT status, COUNT(*)::int AS count
      FROM chat_idempotency
      WHERE ($1::varchar IS NULL OR external_user_id = $1)
        AND ($2::int IS NULL OR user_id = $2)
        AND usage_date = $3::date
      GROUP BY status
      ORDER BY status ASC
    `,
      [args.psid, args.userId, usageDate],
    );

    const retentionEligibleResult = await pool.query(
      `
      SELECT COUNT(*)::int AS count
      FROM chat_idempotency
      WHERE status IN ('completed', 'refunded')
        AND reserved_at < NOW() - ($1::int * INTERVAL '1 day')
    `,
      [retentionDays],
    );

    const idempotencyTotalResult = await pool.query(
      `
      SELECT COUNT(*)::int AS count
      FROM chat_idempotency
    `,
    );

    const denyLogsResult = await pool.query(
      `
      SELECT COUNT(*)::int AS count
      FROM message_logs
      WHERE message_type = 'CHAT_QUOTA_DENIED'
        AND ($1::varchar IS NULL OR external_user_id = $1)
        AND ($2::int IS NULL OR user_id = $2)
        AND created_at::date = $3::date
    `,
      [args.psid, args.userId, usageDate],
    );

    let sharedQueueStats = {
      queueStore:
        process.env.CHAT_QUEUE_STORE ??
        (process.env.CHAT_QUEUE_SHARED === 'true' ? 'redis' : 'memory'),
      historyStore:
        process.env.CHAT_HISTORY_STORE ??
        (process.env.CHAT_QUEUE_SHARED === 'true' ? 'redis' : 'memory'),
      queueSharedEnv: process.env.CHAT_QUEUE_SHARED === 'true',
      note: 'Queue/history buffers live in Redis or in-process memory — postgres tables removed',
    };

    const summary = dailyUsageResult.rows.map((row) => ({
      psid: row.psid,
      userId: row.user_id,
      usageDate: row.usage_date,
      used: row.free_form_count,
      limit: dailyLimit,
      remaining: Math.max(dailyLimit - row.free_form_count, 0),
      whitelisted: readWhitelist().includes(row.psid),
    }));

    console.log(
      JSON.stringify(
        {
          filters: {
            psid: args.psid,
            userId: args.userId,
            usageDate,
          },
          config: {
            enabled: readEnabledFlag(),
            dailyLimit,
            burstPerMinute,
            remainingHintThreshold,
            stuckReservedMs,
            retentionDays,
            timezone,
            whitelistedPsids: readWhitelist(),
          },
          observability: {
            idempotencyByStatus: idempotencyStatsResult.rows,
            idempotencyTableTotal: idempotencyTotalResult.rows[0]?.count ?? 0,
            retentionEligibleCount: retentionEligibleResult.rows[0]?.count ?? 0,
            chatQuotaDeniedLogsToday: denyLogsResult.rows[0]?.count ?? 0,
            sharedQueue: sharedQueueStats,
            logGrepHints: [
              'CHAT_QUOTA_DENY',
              'CHAT_QUOTA_REFUND',
              'CHAT_QUOTA_RECOVERED',
            ],
          },
          runbook: {
            recommendedPoc: {
              dailyLimit: '15-20',
              burstPerMinute: 3,
            },
            recoverStuck: 'npm run chat-quota:recover-stuck',
            cleanupIdempotency: 'npm run chat-quota:cleanup',
            note: 'Bật CHAT_RATE_LIMIT_ENABLED=true trên production POC sau khi QA xong.',
          },
          summary,
          burstLastMinute: args.psid
            ? (burstResult.rows[0]?.recent_count ?? 0)
            : null,
          stuckReserved: stuckResult.rows,
          stuckReservedBefore: stuckBefore.toISOString(),
          dailyUsage: dailyUsageResult.rows,
          idempotency: idempotencyResult.rows,
        },
        null,
        2,
      ),
    );
  }
} finally {
  await pool.end();
}
