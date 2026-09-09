#!/usr/bin/env bash
# Offsite backup sync tests (#866). Self-contained: fakes rclone/curl via PATH.
# Covers: missing credentials, self-check, atomic promote + sidecar verify,
# transfer failure, checksum mismatch, stale/missing local artifacts, bounded
# alert + recovery, and no remote deletes.
# Run: bash .github/scripts/tests/postgres-offsite-sync.test.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SCRIPT="$ROOT/deploy/postgres-offsite-sync.sh"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

FAILED=0
fail() { echo "FAIL: $1" >&2; FAILED=1; }
pass() { echo "  ok: $1"; }

[ -f "$SCRIPT" ] || { echo "FAIL: $SCRIPT missing" >&2; exit 1; }

FAKE_BIN="$TEST_ROOT/bin"
mkdir -p "$FAKE_BIN"

cat > "$FAKE_BIN/rclone" <<'FAKE'
#!/usr/bin/env bash
echo "rclone $*" >> "${RCLONE_LOG:?}"
case "$1" in
  lsl)
    if [ -n "${FAKE_RCLONE_FAIL:-}" ]; then exit 1; fi
    for f in ${FAKE_REMOTE_FILES:-}; do echo "1000 2026-09-08 02:00:00.000000000 $f"; done
    exit 0 ;;
  cat)
    [ -n "${FAKE_RCLONE_FAIL:-}" ] && exit 1
    cat "$RCLONE_STORE/${2#offsite:}" 2>/dev/null || printf '%s' "${FAKE_REMOTE_SHA256:-deadbeef}"
    exit 0 ;;
  copyto|moveto|copy)
    [ -n "${FAKE_RCLONE_FAIL:-}" ] && exit 1
    echo "rclone $*" >> "${RCLONE_WRITES_LOG:-$RCLONE_LOG}"
    if [ -n "${RCLONE_STORE:-}" ]; then
      src="$2"; dst="$3"
      case "$1" in
        copyto)
          dst_path="${dst#offsite:}"
          mkdir -p "$(dirname "$RCLONE_STORE/$dst_path")"
          cp "$src" "$RCLONE_STORE/$dst_path" ;;
        moveto)
          mv "$RCLONE_STORE/${src#offsite:}" "$RCLONE_STORE/${dst#offsite:}" ;;
      esac
    fi
    exit 0 ;;
esac
exit 0
FAKE

cat > "$FAKE_BIN/curl" <<'FAKE'
#!/usr/bin/env bash
echo "curl $*" >> "${CURL_LOG:-/dev/null}"
exit 0
FAKE

chmod +x "$FAKE_BIN"/*

ENV_FILE="$TEST_ROOT/offsite.env"
cat > "$ENV_FILE" <<'ENV'
OFFSITE_S3_ENDPOINT=https://s3.b2.example.com
OFFSITE_S3_BUCKET=wispacedr
OFFSITE_S3_ACCESS_KEY=offsite-access-key
OFFSITE_S3_SECRET_KEY=offsite-secret-key
BACKUP_ENCRYPTION_PASSPHRASE=backup-pass
ENV

BACKUP_DIR="$TEST_ROOT/backups"
mkdir -p "$BACKUP_DIR"
DUMP="$BACKUP_DIR/ai_chat_bot_db-20260908-020000.sql.gz.gpg"
GLOBALS="$BACKUP_DIR/ai_chat_bot_db-20260908-020000.globals.sql.gz.gpg"
STATE="$BACKUP_DIR/ai_chat_bot_db-20260908-020000.state.json.gz.gpg"
printf 'enc-dump' > "$DUMP"
printf 'enc-globals' > "$GLOBALS"
printf 'enc-state' > "$STATE"
EVIDENCE_DIR="$BACKUP_DIR/restore-verify"
mkdir -p "$EVIDENCE_DIR"
printf '{"result": "success"}' > "$EVIDENCE_DIR/restore-verify-20260908-030000.json"
mkdir -p "$BACKUP_DIR/pre-migrate"
printf encrypted-pre-migration-dump > "$BACKUP_DIR/pre-migrate/pre-migrate-20260908-020500.dump.gpg"
date +%s > "$BACKUP_DIR/.last-backup-success"

run_sync() { # <args...>
  RCLONE_LOG="$TEST_ROOT/rclone.log" \
    PATH="$FAKE_BIN:$PATH" bash "$SCRIPT" "$@" 2>&1
}

assert_no_secret_in_logs() {
  ! grep -q 'offsite-secret-key\|backup-pass' "$TEST_ROOT/rclone.log" "$TEST_ROOT/err" 2>/dev/null
}

# --- 1. Missing credentials fail closed --------------------------------------
CURL_LOG="$TEST_ROOT/curl.log" PATH="$FAKE_BIN:$PATH" bash "$SCRIPT" --backup-dir "$BACKUP_DIR" \
  --env-file "$TEST_ROOT/no-such.env" > /dev/null 2>"$TEST_ROOT/err" \
  && fail "missing env file must fail closed" \
  || pass "missing env file fails closed"
grep -q 'postgres_offsite_failed' "$TEST_ROOT/curl.log" \
  || fail "missing env file must fire the offsite alert"

printf 'OFFSITE_S3_ENDPOINT=https://s3.b2.example.com\n' > "$TEST_ROOT/partial.env"
PATH="$FAKE_BIN:$PATH" bash "$SCRIPT" --backup-dir "$BACKUP_DIR" \
  --env-file "$TEST_ROOT/partial.env" > /dev/null 2>"$TEST_ROOT/err2" \
  && fail "incomplete OFFSITE_S3_* must fail closed" \
  || pass "incomplete OFFSITE_S3_* fails closed"
grep -qi 'OFFSITE_S3' "$TEST_ROOT/err2" || fail "error must name the missing OFFSITE_S3 vars"

# --- 2. Self-check (fresh-host bootstrap) ------------------------------------
RCLONE_LOG="$TEST_ROOT/rclone.log" PATH="$FAKE_BIN:$PATH" bash "$SCRIPT" \
  --backup-dir "$BACKUP_DIR" --env-file "$ENV_FILE" --self-check >/dev/null 2>&1 \
  || fail "self-check must pass with valid creds"
grep -q 'rclone lsl' "$TEST_ROOT/rclone.log" || fail "self-check must list the remote bucket"
pass "fresh-host self-check passes without uploading"

CURL_LOG="$TEST_ROOT/curl.log" RCLONE_LOG="$TEST_ROOT/rclone.log" \
  PATH="$FAKE_BIN:$PATH" FAKE_RCLONE_FAIL=1 bash "$SCRIPT" \
  --backup-dir "$BACKUP_DIR" --env-file "$ENV_FILE" --self-check >/dev/null 2>&1 \
  && fail "self-check failure must exit non-zero" \
  || pass "self-check failure exits non-zero"
grep -q 'postgres_offsite_failed' "$TEST_ROOT/curl.log" \
  || fail "self-check failure must fire the offsite alert"

# --- 3. Successful sync: atomic promote + checksum sidecar verify -------------
RCLONE_LOG="$TEST_ROOT/rclone.log" RCLONE_STORE="$TEST_ROOT/store" \
  PATH="$FAKE_BIN:$PATH" bash "$SCRIPT" \
  --backup-dir "$BACKUP_DIR" --env-file "$ENV_FILE" >/dev/null 2>&1 \
  || fail "sync with valid artifacts must exit 0"

grep -q 'copyto' "$TEST_ROOT/rclone.log" || fail "upload must go through copyto (temp prefix)"
grep -q 'moveto' "$TEST_ROOT/rclone.log" || fail "promotion must use moveto (never visible mid-upload)"
grep -q '\.sha256' "$TEST_ROOT/rclone.log" || fail "checksum sidecars must be uploaded"
grep -q 'ai_chat_bot_db-20260908-020000.sql.gz.gpg' "$TEST_ROOT/rclone.log" \
  || fail "latest dump must be uploaded"
grep -q 'globals.sql.gz.gpg' "$TEST_ROOT/rclone.log" \
  || fail "latest globals artifact must be uploaded"
grep -q 'state.json.gz.gpg' "$TEST_ROOT/rclone.log" \
  || fail "state sidecar must be uploaded (#879)"
grep -q 'restore-verify-20260908-030000.json' "$TEST_ROOT/rclone.log" \
  || fail "verification metadata (evidence) must be uploaded"
grep -q 'manifest.tsv' "$TEST_ROOT/rclone.log" \
  || fail "manifest must be uploaded and promoted"
grep -q 'pre-migrate-pre-migrate-20260908-020500.dump.gpg' "$TEST_ROOT/rclone.log" \
  || fail "pre-migration dump must be uploaded"
grep -q 'manifest_version=2' "$TEST_ROOT/store/wispacedr/latest/manifest.tsv" \
  || fail "manifest must be version 2 (with the state sidecar, #879)"
grep -q 'state_sha256' "$TEST_ROOT/store/wispacedr/latest/manifest.tsv" \
  || fail "manifest must record the state sidecar sha256 (#879)"
! grep -qE 'rclone (delete|purge|deletefile)' "$TEST_ROOT/rclone.log" \
  || fail "sync must never delete remote objects"
[ -f "$BACKUP_DIR/.last-offsite-success" ] || fail "success marker must be written"
! grep -q 'offsite-secret-key\|backup-pass' "$TEST_ROOT/rclone.log" \
  || fail "secrets must not appear in rclone args/logs"
pass "successful sync promotes atomically with sidecars and keeps secrets out"

# --- 4. Transfer failure → alert + no marker -----------------------------------
rm -f "$BACKUP_DIR/.last-offsite-success"
RCLONE_LOG="$TEST_ROOT/rclone.log" CURL_LOG="$TEST_ROOT/curl.log" \
  PATH="$FAKE_BIN:$PATH" FAKE_RCLONE_FAIL=1 \
  bash "$SCRIPT" --backup-dir "$BACKUP_DIR" --env-file "$ENV_FILE" >/dev/null 2>"$TEST_ROOT/err4" \
  && fail "transfer failure must exit non-zero" \
  || pass "transfer failure exits non-zero"
grep -q 'postgres_offsite_failed' "$TEST_ROOT/curl.log" \
  || fail "transfer failure must fire the offsite alert"
[ -f "$BACKUP_DIR/.last-offsite-success" ] \
  && fail "failed sync must not write the success marker"

# --- 5. Recovery resolves the alert --------------------------------------------
RCLONE_LOG="$TEST_ROOT/rclone.log" CURL_LOG="$TEST_ROOT/curl.log" \
  RCLONE_STORE="$TEST_ROOT/store" \
  PATH="$FAKE_BIN:$PATH" bash "$SCRIPT" \
  --backup-dir "$BACKUP_DIR" --env-file "$ENV_FILE" >/dev/null 2>&1 \
  || fail "recovery sync must exit 0"
grep -q 'postgres_offsite_failed' "$TEST_ROOT/curl.log" \
  || fail "recovery must resolve the offsite alert (ends_at)"
grep -q 'endsAt' "$TEST_ROOT/curl.log" \
  || fail "recovery alert must carry ends_at"

# --- 6. Checksum mismatch detected ---------------------------------------------
rm -f "$BACKUP_DIR/.last-offsite-success"
RCLONE_LOG="$TEST_ROOT/rclone.log" PATH="$FAKE_BIN:$PATH" FAKE_REMOTE_SHA256=deadbeef \
  bash "$SCRIPT" --backup-dir "$BACKUP_DIR" --env-file "$ENV_FILE" >/dev/null 2>"$TEST_ROOT/err6" \
  && fail "checksum mismatch must exit non-zero" \
  || pass "checksum mismatch exits non-zero"
grep -qi 'checksum' "$TEST_ROOT/err6" || fail "error must name the checksum mismatch"

# --- 7. No local artifacts → fail with alert ------------------------------------
EMPTY_DIR="$TEST_ROOT/empty"
mkdir -p "$EMPTY_DIR"
date +%s > "$EMPTY_DIR/.last-backup-success"
RCLONE_LOG="$TEST_ROOT/rclone.log" PATH="$FAKE_BIN:$PATH" \
  bash "$SCRIPT" --backup-dir "$EMPTY_DIR" --env-file "$ENV_FILE" >/dev/null 2>"$TEST_ROOT/err7" \
  && fail "no local artifacts must exit non-zero" \
  || pass "no local artifacts exits non-zero"
grep -qi 'no.*artifact' "$TEST_ROOT/err7" || fail "error must explain no artifacts found"

# --- 7b. Missing state sidecar → fail closed (#879) -------------------------------
rm -f "$BACKUP_DIR/.last-offsite-success"
NOSTATE_DIR="$TEST_ROOT/nostate"
mkdir -p "$NOSTATE_DIR"
cp "$DUMP" "$GLOBALS" "$NOSTATE_DIR/"
date +%s > "$NOSTATE_DIR/.last-backup-success"
RCLONE_LOG="$TEST_ROOT/rclone.log" CURL_LOG="$TEST_ROOT/curl7b.log" PATH="$FAKE_BIN:$PATH" \
  bash "$SCRIPT" --backup-dir "$NOSTATE_DIR" --env-file "$ENV_FILE" >/dev/null 2>"$TEST_ROOT/err7b" \
  && fail "missing state sidecar must fail closed (#879)" \
  || pass "missing state sidecar fails closed"
grep -qi 'state sidecar' "$TEST_ROOT/err7b" \
  || fail "error must name the missing state sidecar"
[ -f "$NOSTATE_DIR/.last-offsite-success" ] \
  && fail "missing-state run must not write the success marker"

# --- 8. Monitor contract: offsite checks in backup-monitor.sh -------------------
MONITOR="$ROOT/deploy/backup-monitor.sh"
grep -q 'OFFSITE_MARKER\|last-offsite-success' "$MONITOR" \
  || fail "backup-monitor must check the offsite sync marker for freshness"
grep -q 'postgres_offsite_stale' "$MONITOR" \
  || fail "backup-monitor must own the postgres_offsite_stale alert"
grep -q 'RUN_RESTORE_VERIFY' "$MONITOR" \
  || fail "backup-monitor must expose the restore-verify decryptability run"
grep -q 'restore-verify' "$MONITOR" \
  || fail "backup-monitor decryptability path must invoke the restore verifier"
pass "backup-monitor owns offsite freshness + decryptability contract"

if [ "$FAILED" -ne 0 ]; then
  echo "TESTS FAILED" >&2
  exit 1
fi
echo "ALL TESTS PASSED"
