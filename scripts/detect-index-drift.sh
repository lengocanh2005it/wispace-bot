#!/usr/bin/env bash
# detect-index-drift.sh
#
# CI check: detects entity/migration index-name drift while keeping
# synchronize=false. Queries pg_indexes for the relevant tables and
# compares against expected index names derived from entity decorators.
#
# Exit code 1 = drift detected, 0 = no drift.
#
# Usage:
#   DB_HOST=localhost DB_PORT=5432 DB_NAME=ai_chat_bot_db \
#     DB_USER=postgres DB_PASSWORD=secret \
#     bash scripts/detect-index-drift.sh

set -euo pipefail

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-ai_chat_bot_db}"
DB_USER="${DB_USER:-postgres}"
export PGPASSWORD="${DB_PASSWORD:-}"

PSQL="psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -t -A"

DRIFT=0

check_indexes() {
  local table="$1"
  shift
  local expected=("$@")

  actual=$($PSQL -c "
    SELECT indexname FROM pg_indexes
    WHERE tablename = '$table' AND schemaname = 'public'
    ORDER BY indexname;
  ")

  echo "--- $table ---"

  for idx in "${expected[@]}"; do
    if echo "$actual" | grep -q "^${idx}$"; then
      echo "  ✓ $idx"
    else
      echo "  ✗ MISSING: $idx"
      DRIFT=1
    fi
  done

  # Check for indexes in DB not in expected list (potential stale indexes)
  while IFS= read -r idx; do
    if [ -n "$idx" ] && [ "$idx" != "TableName" ]; then
      found=0
      for e in "${expected[@]}"; do
        if [ "$e" = "$idx" ]; then
          found=1
          break
        fi
      done
      if [ "$found" = "0" ]; then
        echo "  ⚠ UNEXPECTED: $idx (not in entity decorators)"
      fi
    fi
  done <<< "$actual"
  echo ""
}

echo "=== Index Drift Detection ==="
echo ""

# Entity-declared indexes per table (must match @Index decorators)
check_indexes "llm_usage_events" \
  "idx_llm_usage_user_date" \
  "idx_llm_usage_platform_external_date" \
  "idx_llm_usage_feature_date" \
  "idx_llm_usage_platform_usage_date" \
  "idx_llm_usage_platform_occurred"

check_indexes "chat_quota_events" \
  "idx_chat_events_aggregate_time" \
  "idx_chat_events_usage_date" \
  "idx_chat_events_occurred_at"

check_indexes "chat_idempotency" \
  "idx_chat_idempotency_platform_external_date" \
  "idx_chat_idempotency_platform_status_reserved" \
  "idx_chat_idempotency_platform_external_reserved"

check_indexes "study_reminder_jobs" \
  "idx_study_reminder_jobs_platform_external_session_key" \
  "idx_study_reminder_jobs_dispatch" \
  "idx_study_reminder_jobs_platform_status_remind" \
  "idx_study_reminder_jobs_status_platform_lease"

check_indexes "webhook_dead_letters" \
  "idx_webhook_dead_letter_platform_status_created" \
  "idx_webhook_dead_letter_retry" \
  "idx_webhook_dead_letter_delivery_key"

check_indexes "webhook_inbound_events" \
  "idx_webhook_inbound_events_stale"

if [ "$DRIFT" -eq 1 ]; then
  echo "✗ DRIFT DETECTED — entity decorators and migration indexes are out of sync."
  echo "  Run 'npm run migration:run' and update entity decorators or migrations."
  exit 1
else
  echo "✓ No index drift detected."
  exit 0
fi
