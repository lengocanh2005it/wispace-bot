#!/usr/bin/env bash
set -euo pipefail

# Test suite for postgres-backup.sh fail-safe execution (Issue #1325)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
BACKUP_SCRIPT="$REPO_DIR/deploy/postgres-backup.sh"

TMP_DIR=$(mktemp -d "/tmp/test-postgres-backup.XXXXXX" 2>/dev/null || mktemp -d -t 'test-postgres-backup.XXXXXX')
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

FAKE_BIN="$TMP_DIR/bin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/curl" <<'FAKE'
#!/usr/bin/env bash
exit 0
FAKE
cat > "$FAKE_BIN/rclone" <<'FAKE'
#!/usr/bin/env bash
exit 0
FAKE
chmod +x "$FAKE_BIN"/*
export PATH="$FAKE_BIN:$PATH"

echo "=== Testing postgres-backup.sh fail-safe behavior ==="

# Test 1: Missing BACKUP_ENCRYPTION_PASSPHRASE in env file
# Proves the script does not crash silently on line 36 due to grep pipefail.
ENV_MISSING_PASSPHRASE="$TMP_DIR/missing_passphrase.env"
cat > "$ENV_MISSING_PASSPHRASE" <<'ENV'
DB_HOST=127.0.0.1
DB_PORT=5432
DB_NAME=ai_chat_bot_db
DB_USER=test_user
DB_PASSWORD=test_pw
ENV

OUT_FILE="$TMP_DIR/test1.stdout"
ERR_FILE="$TMP_DIR/test1.stderr"
set +e
ENV_FILE="$ENV_MISSING_PASSPHRASE" BACKUP_DIR="$TMP_DIR/backups" bash "$BACKUP_SCRIPT" >"$OUT_FILE" 2>"$ERR_FILE"
EXIT_CODE=$?
set -e

if [ "$EXIT_CODE" -eq 0 ]; then
  echo "FAIL: Expected script to fail with missing passphrase, but got exit code 0" >&2
  exit 1
fi

# Must print startup banner to stdout
if ! grep -Eq '\[postgres-backup\] Starting' "$OUT_FILE"; then
  echo "FAIL: Missing startup timestamp banner in stdout. stdout was:" >&2
  cat "$OUT_FILE" >&2
  exit 1
fi

# Must print explicit actionable error to stderr
if ! grep -E -q "ERROR.*missing BACKUP_ENCRYPTION_PASSPHRASE in $ENV_MISSING_PASSPHRASE" "$ERR_FILE"; then
  echo "FAIL: Missing explicit passphrase error message in stderr. stderr was:" >&2
  cat "$ERR_FILE" >&2
  exit 1
fi
echo "  ok: missing passphrase prints startup banner and actionable error without silent crash"

# Test 2: Non-existent ENV_FILE
OUT_FILE="$TMP_DIR/test2.stdout"
ERR_FILE="$TMP_DIR/test2.stderr"
set +e
ENV_FILE="$TMP_DIR/does_not_exist.env" BACKUP_DIR="$TMP_DIR/backups" bash "$BACKUP_SCRIPT" >"$OUT_FILE" 2>"$ERR_FILE"
EXIT_CODE=$?
set -e

if [ "$EXIT_CODE" -eq 0 ]; then
  echo "FAIL: Expected script to fail with non-existent env file, but got exit code 0" >&2
  exit 1
fi

if ! grep -Eq '\[postgres-backup\] Starting' "$OUT_FILE"; then
  echo "FAIL: Missing startup banner when env file does not exist" >&2
  exit 1
fi

if ! grep -E -q "ERROR.*env file does not exist at $TMP_DIR/does_not_exist.env" "$ERR_FILE"; then
  echo "FAIL: Missing explicit missing env file error message. stderr was:" >&2
  cat "$ERR_FILE" >&2
  exit 1
fi
echo "  ok: missing env file prints banner and explicit error"

# Test 3: postgres-offsite-sync.sh fail-safe banner and non-existent ENV_FILE
OFFSITE_SCRIPT="$REPO_DIR/deploy/postgres-offsite-sync.sh"
OUT_FILE="$TMP_DIR/test3.stdout"
ERR_FILE="$TMP_DIR/test3.stderr"
set +e
bash "$OFFSITE_SCRIPT" --backup-dir "$TMP_DIR/backups" --env-file "$TMP_DIR/does_not_exist.env" >"$OUT_FILE" 2>"$ERR_FILE"
EXIT_CODE=$?
set -e

if [ "$EXIT_CODE" -eq 0 ]; then
  echo "FAIL: Expected offsite sync to fail with non-existent env file, got 0" >&2
  exit 1
fi

if ! grep -Eq '\[postgres-offsite-sync\] Starting' "$OUT_FILE"; then
  echo "FAIL: Missing startup banner in offsite-sync stdout" >&2
  exit 1
fi

if ! grep -E -q "ERROR.*missing env file: $TMP_DIR/does_not_exist.env" "$ERR_FILE"; then
  echo "FAIL: Missing explicit missing env file error message in offsite-sync. stderr was:" >&2
  cat "$ERR_FILE" >&2
  exit 1
fi
echo "  ok: offsite sync prints banner and explicit error"

echo "ALL POSTGRES-BACKUP TESTS PASSED"
