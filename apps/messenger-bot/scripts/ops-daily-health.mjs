import { createPool } from './_db.mjs';
import { parseArgs } from './_args.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  studyReminderTerminalFailurePredicateSql,
} = require('@wispace/study-reminder-shared');

const HELP = `Usage: npm run ops:health -- [options]

Combined I1 + S1 ops snapshot from PostgreSQL (no app process required).

Options:
  --warn-only           Print only alerts (human-readable)
  --failed-hours=<n>    Study reminder terminal failed lookback (default 24)
  --stuck-minutes=<n>   Study reminder stuck processing threshold (default 10)
  --deny-hours=<n>      Chat quota denied logs lookback (default 24)
  -h, --help            Show this help
`;

function readPositiveNumber(raw, label) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number`);
  }

  return Math.floor(value);
}

function todayUsageDate(timezone, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function readPositiveEnv(key, fallback) {
  const raw = process.env[key]?.trim();
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.floor(value);
}

function readStuckReservedMs() {
  return readPositiveEnv('CHAT_IDEMPOTENCY_STUCK_RESERVED_MS', 600_000);
}

function readDailyLimit() {
  return readPositiveEnv('CHAT_FREE_FORM_DAILY_LIMIT', 15);
}

const args = parseArgs(process.argv.slice(2), {
  defaults: {
    warnOnly: false,
    failedHours: 24,
    stuckMinutes: 10,
    denyHours: 24,
  },
  help: HELP,
  handle: (a, arg) => {
    if (arg === '--warn-only') {
      a.warnOnly = true;
      return true;
    }
    if (arg.startsWith('--failed-hours=')) {
      a.failedHours = readPositiveNumber(
        arg.slice('--failed-hours='.length),
        '--failed-hours',
      );
      return true;
    }
    if (arg.startsWith('--stuck-minutes=')) {
      a.stuckMinutes = readPositiveNumber(
        arg.slice('--stuck-minutes='.length),
        '--stuck-minutes',
      );
      return true;
    }
    if (arg.startsWith('--deny-hours=')) {
      a.denyHours = readPositiveNumber(
        arg.slice('--deny-hours='.length),
        '--deny-hours',
      );
      return true;
    }
    return false;
  },
});
const timezone = process.env.CHAT_USAGE_TIMEZONE?.trim() ?? 'Asia/Ho_Chi_Minh';
const usageDate = todayUsageDate(timezone);
const dailyLimit = readDailyLimit();
const stuckReservedMs = readStuckReservedMs();
const stuckBefore = new Date(Date.now() - stuckReservedMs);
const failedSince = new Date(Date.now() - args.failedHours * 60 * 60 * 1000);
const stuckProcessingBefore = new Date(
  Date.now() - args.stuckMinutes * 60 * 1000,
);
const denySince = new Date(Date.now() - args.denyHours * 60 * 60 * 1000);

const pool = createPool();

try {
  const [
    studyCounts,
    terminalFailed,
    stuckProcessing,
    terminalFailedSamples,
    stuckProcessingSamples,
    stuckReserved,
    idempotencyByStatus,
    usersAtDailyLimit,
    denyLogs,
  ] = await Promise.all([
    pool.query(
      `
        SELECT status, COUNT(*)::int AS count
        FROM study_reminder_jobs
        GROUP BY status
        ORDER BY status ASC
      `,
    ),
    pool.query(
      `
        SELECT COUNT(*)::int AS count
        FROM study_reminder_jobs
        WHERE ${studyReminderTerminalFailurePredicateSql()}
          AND updated_at >= $1::timestamptz
      `,
      [failedSince],
    ),
    pool.query(
      `
        SELECT COUNT(*)::int AS count
        FROM study_reminder_jobs
        WHERE status = 'processing'
          AND updated_at <= $1::timestamptz
      `,
      [stuckProcessingBefore],
    ),
    pool.query(
      `
        SELECT id, external_user_id AS psid, user_id, session_key, remind_at, status, retry_count, max_retries, last_error, delivery_key, delivery_status, updated_at
        FROM study_reminder_jobs
        WHERE ${studyReminderTerminalFailurePredicateSql()}
          AND updated_at >= $1::timestamptz
        ORDER BY updated_at DESC
        LIMIT 20
      `,
      [failedSince],
    ),
    pool.query(
      `
        SELECT id, external_user_id AS psid, user_id, session_key, remind_at, status, updated_at
        FROM study_reminder_jobs
        WHERE status = 'processing'
          AND updated_at <= $1::timestamptz
        ORDER BY updated_at ASC
        LIMIT 20
      `,
      [stuckProcessingBefore],
    ),
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
  ]);

  const minFailedJobs = readPositiveEnv('OPS_ALERT_MIN_FAILED_JOBS', 1);
  const minStuckReserved = readPositiveEnv('OPS_ALERT_MIN_STUCK_RESERVED', 1);
  const minStuckProcessing = readPositiveEnv(
    'OPS_ALERT_MIN_STUCK_PROCESSING',
    1,
  );

  const terminalFailedCount = terminalFailed.rows[0]?.count ?? 0;
  const stuckProcessingCount = stuckProcessing.rows[0]?.count ?? 0;
  const stuckReservedCount = stuckReserved.rows[0]?.count ?? 0;
  const denyLogsCount = denyLogs.rows[0]?.count ?? 0;

  const alerts = [];

  if (terminalFailedCount >= minFailedJobs) {
    alerts.push({
      code: 'STUDY_REMINDER_TERMINAL_FAILED',
      severity: 'warn',
      message: `${terminalFailedCount} terminal failed job(s) in last ${args.failedHours}h`,
    });
  }

  if (stuckProcessingCount >= minStuckProcessing) {
    alerts.push({
      code: 'STUDY_REMINDER_STUCK_PROCESSING',
      severity: 'warn',
      message: `${stuckProcessingCount} job(s) stuck in processing > ${args.stuckMinutes}m`,
    });
  }

  if (stuckReservedCount >= minStuckReserved) {
    alerts.push({
      code: 'CHAT_QUOTA_STUCK_RESERVED',
      severity: 'warn',
      message: `${stuckReservedCount} idempotency row(s) stuck in reserved`,
    });
  }

  const snapshot = {
    generatedAt: new Date().toISOString(),
    chatQuota: {
      usageDate,
      stuckReserved: stuckReservedCount,
      stuckReservedMs,
      denyLogs24h: denyLogsCount,
      usersAtDailyLimit: usersAtDailyLimit.rows[0]?.count ?? 0,
      dailyLimit,
      idempotencyByStatus: Object.fromEntries(
        idempotencyByStatus.rows.map((row) => [row.status, row.count]),
      ),
      logGrepHints: [
        'CHAT_QUOTA_DENY',
        'CHAT_QUOTA_REFUND',
        'CHAT_QUOTA_RECOVERED',
      ],
    },
    studyReminder: {
      countsByStatus: Object.fromEntries(
        studyCounts.rows.map((row) => [row.status, row.count]),
      ),
      terminalFailedSince: terminalFailedCount,
      stuckProcessing: stuckProcessingCount,
      failedHours: args.failedHours,
      stuckProcessingMinutes: args.stuckMinutes,
      samples: {
        terminalFailed: terminalFailedSamples.rows,
        stuckProcessing: stuckProcessingSamples.rows,
      },
    },
    alerts,
    runbook: {
      chatQuotaStatus: 'npm run chat-quota:status -- --ops',
      studyReminderFailed: 'npm run study-reminder:jobs -- --failed',
      studyReminderStuck: 'npm run study-reminder:jobs -- --stuck',
      recoverStuckQuota: 'npm run chat-quota:recover-stuck -- --dry-run',
      logGrep: [
        'grep CHAT_QUOTA_DENY application.log',
        'grep CHAT_QUOTA_REFUND application.log',
        'grep CHAT_QUOTA_RECOVERED application.log',
        'grep OPS_HEALTH_ALERT application.log',
        'grep STUDY_REMINDER_OPS application.log',
      ],
    },
  };

  if (args.warnOnly) {
    if (!alerts.length) {
      console.log('OPS_HEALTH_OK — no alerts');
      process.exit(0);
    }

    for (const alert of alerts) {
      console.log(
        `[${alert.severity.toUpperCase()}] ${alert.code}: ${alert.message}`,
      );
    }

    process.exit(1);
  }

  console.log(JSON.stringify(snapshot, null, 2));
  process.exit(alerts.length > 0 ? 1 : 0);
} finally {
  await pool.end();
}
