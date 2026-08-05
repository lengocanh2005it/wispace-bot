#!/usr/bin/env bash
set -euo pipefail

# Verify a backup can be restored. Non-destructive: restores into a
# temporary database, checks row counts, then drops the temp DB.
#
# Usage: bash deploy/postgres-restore-test.sh [backup-file]
# If no file given, picks the most recent backup in the standard dir.

ENV_FILE="${ENV_FILE:-/home/ngoc_anh/messenger-bot/.env}"
BACKUP_DIR="${BACKUP_DIR:-/home/ngoc_anh/backups/ai_chat_bot_db}"
DB_CONTAINER="${DB_CONTAINER:-postgres_n8n_db}"
TEST_DB="restore_test_$$"

DB_USER=$(grep -E '^DB_USER=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
DB_NAME=$(grep -E '^DB_NAME=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
DB_PASSWORD=$(grep -E '^DB_PASSWORD=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'")

PSQL="docker exec -e PGPASSWORD=$DB_PASSWORD $DB_CONTAINER psql -U $DB_USER -h localhost"

# Always drop the temp DB, even when set -e exits mid-restore.
trap '$PSQL -c "DROP DATABASE IF EXISTS $TEST_DB;" >/dev/null 2>&1 || true' EXIT

BACKUP_FILE="${1:-$(ls -t "$BACKUP_DIR"/*.sql.gz 2>/dev/null | head -1)}"
if [ -z "$BACKUP_FILE" ] || [ ! -f "$BACKUP_FILE" ]; then
  echo "ERROR: no backup file found in $BACKUP_DIR" >&2
  exit 1
fi

echo "=== Restore test ==="
echo "Backup: $(basename "$BACKUP_FILE") ($(du -h "$BACKUP_FILE" | cut -f1))"
echo "Test DB: $TEST_DB"

# Create empty test DB
$PSQL -c "CREATE DATABASE $TEST_DB;" 2>/dev/null

# Restore (gunzip + psql / pg_restore). A failing restore fails the test.
if [[ "$BACKUP_FILE" == *.sql.gz ]]; then
  gunzip -c "$BACKUP_FILE" | docker exec -i -e PGPASSWORD=$DB_PASSWORD "$DB_CONTAINER" \
    psql -U "$DB_USER" -d "$TEST_DB" -h localhost -q 2>/dev/null
elif [[ "$BACKUP_FILE" == *.dump ]]; then
  docker exec -i -e PGPASSWORD=$DB_PASSWORD "$DB_CONTAINER" \
    pg_restore -U "$DB_USER" -d "$TEST_DB" -h localhost --no-owner --no-acl 2>/dev/null
else
  echo "Unknown format: $BACKUP_FILE" >&2
  exit 1
fi

# Verify tables exist and have rows
TABLES=$($PSQL -d "$TEST_DB" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")
echo "Tables restored: $TABLES"
if [ "$TABLES" -lt 5 ]; then
  echo "FAIL: expected at least 5 tables, got $TABLES" >&2
  exit 1
fi

FAILED=0
for tbl in user_platform_mappings messenger_chat_events; do
  cnt=$($PSQL -d "$TEST_DB" -tAc "SELECT count(*) FROM $tbl" 2>/dev/null || echo 0)
  echo "  $tbl: $cnt rows"
  [ "$cnt" -ge 1 ] || FAILED=1
done

if [ "$FAILED" = 1 ]; then
  echo "FAIL: backup restored but key tables are empty" >&2
  exit 1
fi

echo "=== Restore test PASSED ==="
