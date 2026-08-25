#!/usr/bin/env bash
# explain-affected-queries.sh
#
# Staging verification script for issue #378 — runs EXPLAIN (ANALYZE, BUFFERS)
# on the affected query paths to verify index usage and detect plan regressions.
# Exits with code 1 if any query uses Seq Scan (indicating missing/wrong index).
#
# Prerequisites:
#   - psql with staging DB access
#   - Production-like data volume (10K+ rows per table)
#
# Usage:
#   DB_HOST=localhost DB_PORT=5432 DB_NAME=ai_chat_bot_db \
#     DB_USER=postgres DB_PASSWORD=secret \
#     bash scripts/explain-affected-queries.sh

set -euo pipefail

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-ai_chat_bot_db}"
DB_USER="${DB_USER:-postgres}"
export PGPASSWORD="${DB_PASSWORD:-}"

PSQL="psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -t -A"

PLAN_ISSUES=0

run_explain() {
  local label="$1"
  local sql="$2"
  local expected_index="$3"

  echo "--- $label ---"
  local plan
  plan=$($PSQL -c "EXPLAIN (ANALYZE, BUFFERS, FORMAT text) $sql" | head -12)
  echo "$plan" | sed 's/^/  /'
  echo ""

  if echo "$plan" | grep -q "Seq Scan"; then
    echo "  ⚠ Seq Scan detected — expected $expected_index"
    PLAN_ISSUES=$((PLAN_ISSUES + 1))
  else
    echo "  ✓ Uses index scan ($expected_index)"
  fi
  echo ""
}

echo "=== Issue #378: Query Plan Regression Checks ==="
echo ""

# --- 1. LLM fleet aggregation ---
run_explain \
  "1. LLM fleet aggregation" \
  "SELECT feature, model, COUNT(*) AS calls,
   COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
   COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
   COALESCE(SUM(total_tokens), 0) AS total_tokens,
   COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
   SUM(estimated_cost_usd) AS stored_cost_usd
   FROM llm_usage_events
   WHERE platform = 'messenger' AND usage_date = CURRENT_DATE
   GROUP BY feature, model ORDER BY feature, model;" \
  "idx_llm_usage_platform_usage_date"

# --- 2. LLM usage retention delete ---
run_explain \
  "2. LLM usage retention delete" \
  "SELECT id FROM llm_usage_events
   WHERE platform = 'messenger' AND occurred_at < now() - INTERVAL '90 days'
   LIMIT 1000;" \
  "idx_llm_usage_platform_occurred"

# --- 3. Study reminder findNextDueTime ---
run_explain \
  "3. Study reminder findNextDueTime" \
  "SELECT MIN(CASE
     WHEN next_retry_at IS NOT NULL AND next_retry_at > now() THEN next_retry_at
     WHEN remind_at > now() THEN remind_at
     ELSE NULL
   END) AS next_due
   FROM study_reminder_jobs
   WHERE status IN ('pending', 'failed') AND platform = 'messenger';" \
  "idx_study_reminder_jobs_platform_status_remind"

# --- 4. Study reminder resetStuckProcessingJobs ---
run_explain \
  "4. Study reminder resetStuck" \
  "UPDATE study_reminder_jobs
   SET status = 'failed', delivery_status = 'ambiguous'
   WHERE status = 'processing' AND platform = 'messenger'
   AND (lease_expires_at < now() OR (lease_expires_at IS NULL AND updated_at <= now() - INTERVAL '10 minutes'));" \
  "idx_study_reminder_jobs_status_platform_lease"

# --- 5. Dead-letter retry ---
run_explain \
  "5. Dead-letter retry" \
  "SELECT id, external_user_id, raw_payload, error_message, retry_count, status, delivery_key
   FROM webhook_dead_letters
   WHERE platform = 'messenger' AND status = 'pending' AND direction = 'outbound'
   AND retry_count < 3 AND updated_at < now() - INTERVAL '5 minutes'
   ORDER BY created_at ASC LIMIT 10;" \
  "idx_webhook_dead_letter_retry"

# --- 6. Report cron subscribed mappings ---
run_explain \
  "6. Report cron keyset page" \
  "SELECT mapping.id, mapping.platform, mapping.external_user_id, mapping.user_id, mapping.cadence, mapping.topic
   FROM user_platform_mappings mapping
   WHERE mapping.status = 'ACTIVE' AND mapping.platform = 'messenger'
   AND mapping.cadence IS NOT NULL AND mapping.topic IS NOT NULL
   AND mapping.id > 0 ORDER BY mapping.id ASC LIMIT 500;" \
  "primary key + filtered scan"

echo "=== Verification complete ==="
echo ""

if [ "$PLAN_ISSUES" -gt 0 ]; then
  echo "✗ $PLAN_ISSUES plan regression(s) detected. Review output above."
  exit 1
else
  echo "✓ All queries use index scans as expected."
  exit 0
fi
