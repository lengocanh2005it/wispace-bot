#!/usr/bin/env bash
# verify-retention-bounded-batch.sh
#
# Staging-only verification script for issue #377 bounded-batch retention.
# Run against a staging PostgreSQL instance with synthetic data to verify:
#   1. Bounded lock duration (batch-by-batch execution)
#   2. Rows per batch (1000 max)
#   3. Query plan uses new indexes
#   4. Cleanup completion under backlog
#
# Prerequisites:
#   - psql with staging DB access
#   - At least 2500 synthetic rows in llm_usage_events / chat_quota_events
#
# Usage:
#   DB_HOST=localhost DB_PORT=5432 DB_NAME=ai_chat_bot_db \
#     DB_USER=postgres DB_PASSWORD=secret \
#     bash scripts/verify-retention-bounded-batch.sh

set -euo pipefail

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-ai_chat_bot_db}"
DB_USER="${DB_USER:-postgres}"
export PGPASSWORD="${DB_PASSWORD:-}"

PSQL="psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -t -A"

echo "=== Issue #377: Bounded-Batch Retention Verification ==="
echo ""

# --- 1. Insert synthetic backlog ---
echo "1. Inserting synthetic backlog (3000 rows)..."

$PSQL -c "
INSERT INTO llm_usage_events (platform, feature, model, prompt_tokens, completion_tokens, total_tokens, status)
SELECT
  'messenger',
  'FREE_FORM_CHAT',
  'gpt-5.4',
  10, 5, 15, 'ok'
FROM generate_series(1, 3000);
"

$PSQL -c "
INSERT INTO chat_quota_events (platform, aggregate_id, aggregate_type, event_type, payload, usage_date)
SELECT
  'messenger',
  'synthetic-' || g,
  'chat_quota',
  'CHAT_QUOTA_RESERVED',
  '{}',
  CURRENT_DATE - 90
FROM generate_series(1, 3000) g;
"

ROW_COUNT_LLM=$($PSQL -c "SELECT COUNT(*) FROM llm_usage_events;")
ROW_COUNT_QUOTA=$($PSQL -c "SELECT COUNT(*) FROM chat_quota_events;")
echo "   llm_usage_events: $ROW_COUNT_LLM rows"
echo "   chat_quota_events: $ROW_COUNT_QUOTA rows"
echo ""

# --- 2. Verify index usage ---
echo "2. Checking query plans use new indexes..."

LLM_PLAN=$($PSQL -c "
EXPLAIN (FORMAT text)
SELECT id FROM llm_usage_events
WHERE platform = 'messenger' AND occurred_at < now() - INTERVAL '90 days'
LIMIT 1000;
")
echo "   llm_usage_events plan:"
echo "$LLM_PLAN" | head -3 | sed 's/^/     /'

if echo "$LLM_PLAN" | grep -q "idx_llm_usage_platform_occurred"; then
  echo "   ✓ Uses idx_llm_usage_platform_occurred"
else
  echo "   ✗ MISSING index usage — check plan above"
fi

QUOTA_PLAN=$($PSQL -c "
EXPLAIN (FORMAT text)
SELECT id FROM chat_quota_events
WHERE occurred_at < now() - INTERVAL '90 days'
LIMIT 1000;
")
echo "   chat_quota_events plan:"
echo "$QUOTA_PLAN" | head -3 | sed 's/^/     /'

if echo "$QUOTA_PLAN" | grep -q "idx_chat_events_occurred_at"; then
  echo "   ✓ Uses idx_chat_events_occurred_at"
else
  echo "   ✗ MISSING index usage — check plan above"
fi
echo ""

# --- 3. Run retention and measure ---
echo "3. Running retention cleanup (simulating bounded batch)..."
START=$(date +%s%N)

DELETED_LLM=$($PSQL -c "
WITH batch AS (
  SELECT id FROM llm_usage_events
  WHERE platform = 'messenger' AND occurred_at < now() - INTERVAL '90 days'
  LIMIT 1000
)
DELETE FROM llm_usage_events WHERE id IN (SELECT id FROM batch)
RETURNING id;
" | wc -l)

DELETED_QUOTA=$($PSQL -c "
WITH batch AS (
  SELECT id FROM chat_quota_events
  WHERE occurred_at < now() - INTERVAL '90 days'
  LIMIT 1000
)
DELETE FROM chat_quota_events WHERE id IN (SELECT id FROM batch)
RETURNING id;
" | wc -l)

END=$(date +%s%N)
DURATION_MS=$(( (END - START) / 1000000 ))

echo "   Deleted $DELETED_LLM llm_usage_events rows in this batch"
echo "   Deleted $DELETED_QUOTA chat_quota_events rows in this batch"
echo "   Batch duration: ${DURATION_MS}ms"
echo ""

# --- 4. Verify lock duration is bounded ---
echo "4. Lock duration check..."
if [ "$DURATION_MS" -lt 5000 ]; then
  echo "   ✓ Batch completed in ${DURATION_MS}ms (< 5s target)"
else
  echo "   ✗ Batch took ${DURATION_MS}ms — investigate lock duration"
fi
echo ""

# --- 5. Cleanup verification ---
REMAINING_LLM=$($PSQL -c "SELECT COUNT(*) FROM llm_usage_events;")
REMAINING_QUOTA=$($PSQL -c "SELECT COUNT(*) FROM chat_quota_events;")
echo "5. Remaining rows:"
echo "   llm_usage_events: $REMAINING_LLM"
echo "   chat_quota_events: $REMAINING_QUOTA"
echo ""

echo "=== Verification complete ==="
