#!/bin/bash
# EXPLAIN baseline for key study-reminder and chat queries (#270).
# Run against a real PostgreSQL instance with representative data.
# Usage: DB_HOST=localhost DB_PORT=5432 DB_USER=postgres DB_NAME=ai_chat_bot_db bash scripts/explain-baseline.sh

set -euo pipefail

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_USER="${DB_USER:-postgres}"
DB_NAME="${DB_NAME:-ai_chat_bot_db}"

PSQL="psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME"

echo "=== EXPLAIN ANALYZE Baseline — $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
echo ""

# 1. findNextDueTime — platform-scoped (#265 fix)
echo "--- 1. findNextDueTime (platform=messenger) ---"
$PSQL -c "
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT MIN(
  CASE
    WHEN next_retry_at IS NOT NULL AND next_retry_at > now() THEN next_retry_at
    WHEN remind_at > now() THEN remind_at
    ELSE NULL
  END
) AS next_due
FROM study_reminder_jobs
WHERE status IN ('pending', 'failed')
  AND platform = 'messenger';
"

echo ""
echo "--- 2. findNextDueTime (all platforms — old behavior) ---"
$PSQL -c "
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT MIN(
  CASE
    WHEN next_retry_at IS NOT NULL AND next_retry_at > now() THEN next_retry_at
    WHEN remind_at > now() THEN remind_at
    ELSE NULL
  END
) AS next_due
FROM study_reminder_jobs
WHERE status IN ('pending', 'failed');
"

echo ""
echo "--- 3. findDueJobs (platform=messenger) ---"
$PSQL -c "
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT *
FROM study_reminder_jobs
WHERE status IN ('pending', 'failed')
  AND platform = 'messenger'
  AND (
    (next_retry_at IS NOT NULL AND next_retry_at <= now())
    OR (next_retry_at IS NULL AND remind_at <= now() + interval '30 minutes')
  )
ORDER BY
  CASE
    WHEN next_retry_at IS NOT NULL THEN next_retry_at
    ELSE remind_at
  END
ASC
LIMIT 10;
"

echo ""
echo "--- 4. claimJob (platform=messenger) ---"
$PSQL -c "
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
UPDATE study_reminder_jobs
SET status = 'processing',
    lease_token = gen_random_uuid(),
    lease_expires_at = now() + interval '10 minutes',
    processing_started_at = now(),
    updated_at = now()
WHERE id = (
  SELECT id FROM study_reminder_jobs
  WHERE status = 'pending'
    AND platform = 'messenger'
    AND remind_at <= now()
  ORDER BY remind_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
RETURNING id;
"

echo ""
echo "--- 5. Webhook inbound countDue (platform=messenger) ---"
$PSQL -c "
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT LEAST(COUNT(*), 10000)::text AS count
FROM webhook_inbound_events
WHERE platform = 'messenger'
  AND (
    (status IN ('pending', 'failed') AND (next_retry_at IS NULL OR next_retry_at <= now()))
    OR (status = 'processing' AND updated_at < now() - interval '5 minutes')
  );
"

echo ""
echo "=== Index usage summary ==="
$PSQL -c "
SELECT
  schemaname, tablename, indexname,
  idx_scan, idx_tup_read, idx_tup_fetch
FROM pg_stat_user_indexes
WHERE schemaname = 'public'
  AND tablename IN ('study_reminder_jobs', 'webhook_inbound_events', 'chat_idempotency')
ORDER BY tablename, idx_scan DESC;
"

echo ""
echo "=== Table bloat estimate ==="
$PSQL -c "
SELECT
  tablename,
  pg_size_pretty(pg_total_relation_size(schemaname || '.' || tablename)) AS total_size,
  n_live_tup, n_dead_tup,
  CASE WHEN n_live_tup > 0
    THEN round(100.0 * n_dead_tup / n_live_tup, 1)
    ELSE 0
  END AS dead_pct
FROM pg_stat_user_tables
WHERE schemaname = 'public'
  AND tablename IN ('study_reminder_jobs', 'webhook_inbound_events', 'chat_idempotency', 'chat_daily_usage')
ORDER BY pg_total_relation_size(schemaname || '.' || tablename) DESC;
"

echo ""
echo "=== Done ==="
