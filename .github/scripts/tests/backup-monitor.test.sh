#!/usr/bin/env bash
# Behavior tests for deploy/backup-monitor.sh (#866): local/offsite freshness,
# bounded alert + recovery, and the RUN_RESTORE_VERIFY decryptability run.
# Run: bash .github/scripts/tests/backup-monitor.test.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
MONITOR="$ROOT/deploy/backup-monitor.sh"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

FAILED=0
fail() { echo "FAIL: $1" >&2; FAILED=1; }
pass() { echo "  ok: $1"; }

[ -f "$MONITOR" ] || { echo "FAIL: $MONITOR missing" >&2; exit 1; }

FAKE_BIN="$TEST_ROOT/bin"
mkdir -p "$FAKE_BIN"

cat > "$FAKE_BIN/curl" <<'FAKE'
#!/usr/bin/env bash
echo "curl $*" >> "${CURL_LOG:?}"
exit 0
FAKE

chmod +x "$FAKE_BIN"/*

# fake-verify: the monitor invokes `bash "$RESTORE_VERIFY_SCRIPT"` — the real
# bash resolves first (only `bash` itself must NOT be faked), so the fake is a
# plain script whose exit code we control via FAKE_VERIFY_FAIL.
cat > "$FAKE_BIN/fake-verify" <<'FAKE'
#!/usr/bin/env bash
echo "restore-verify $*" >> "${RESTORE_VERIFY_LOG:-/dev/null}"
[ -n "${FAKE_VERIFY_FAIL:-}" ] && exit 1 || exit 0
FAKE
chmod +x "$FAKE_BIN/fake-verify"

BACKUP_DIR="$TEST_ROOT/backups"
mkdir -p "$BACKUP_DIR"

run_monitor() { # <VAR=val...> — env assignments passed as arguments
  local var
  for var in "$@"; do
    case "$var" in *=*) export "$var" ;; *) break ;; esac
  done
  CURL_LOG="$TEST_ROOT/curl.log" PATH="$FAKE_BIN:$PATH" BACKUP_DIR="$BACKUP_DIR" \
    RESTORE_VERIFY_SCRIPT="$FAKE_BIN/fake-verify" bash "$MONITOR"
  local status=$?
  # unset the per-run overrides so they do not leak into the next run
  for var in "$@"; do
    case "$var" in *=*) unset "${var%%=*}" ;; *) break ;; esac
  done
  return "$status"
}

now=$(date +%s)
echo "$now" > "$BACKUP_DIR/.last-backup-success"
echo "$now" > "$BACKUP_DIR/.last-offsite-success"

# --- 1. Healthy: no alerts, exit 0 ----------------------------------------------
run_monitor >/dev/null 2>&1 || fail "healthy monitor must exit 0"
if grep -q 'summary' "$TEST_ROOT/curl.log" 2>/dev/null; then
  fail "healthy monitor must not fire any alert"
fi
pass "healthy monitor exits 0 without alerts"

# --- 2. Missing offsite marker → postgres_offsite_stale + non-zero ---------------
rm -f "$BACKUP_DIR/.last-offsite-success"
run_monitor >/dev/null 2>&1 && fail "missing offsite marker must exit non-zero" || true
grep -q 'postgres_offsite_stale' "$TEST_ROOT/curl.log" \
  || fail "missing offsite marker must fire postgres_offsite_stale"
pass "missing offsite marker fires the offsite alert"

# --- 3. Stale offsite marker → alert with age ------------------------------------
echo $((now - 26 * 3600)) > "$BACKUP_DIR/.last-offsite-success"
run_monitor >/dev/null 2>&1 && fail "stale offsite marker must exit non-zero" || true
grep -q 'Offsite backup stale (26h)' "$TEST_ROOT/curl.log" \
  || fail "stale offsite alert must report the age"
pass "stale offsite marker fires the offsite alert with age"

# --- 4. Recovery resolves with ends_at -------------------------------------------
echo "$now" > "$BACKUP_DIR/.last-offsite-success"
run_monitor >/dev/null 2>&1 || fail "recovered monitor must exit 0"
grep -q '"endsAt"' "$TEST_ROOT/curl.log" || fail "recovery must carry ends_at"
pass "recovery resolves the offsite alert"

# --- 5. RUN_RESTORE_VERIFY=1 invokes the verifier; failure alerts ------------------
printf enc > "$BACKUP_DIR/ai_chat_bot_db-20260908-020000.sql.gz.gpg"
printf enc > "$BACKUP_DIR/ai_chat_bot_db-20260908-020000.globals.sql.gz.gpg"

RESTORE_VERIFY_LOG="$TEST_ROOT/verify.log" \
  run_monitor RUN_RESTORE_VERIFY=1 RESTORE_VERIFY_LOG="$TEST_ROOT/verify.log" >/dev/null 2>&1 \
  || fail "RUN_RESTORE_VERIFY=1 with healthy verify must exit 0"
grep -q 'restore-verify' "$TEST_ROOT/verify.log" \
  || fail "RUN_RESTORE_VERIFY=1 must invoke the restore verifier"
grep -q 'globals.sql.gz.gpg' "$TEST_ROOT/verify.log" \
  || fail "verifier must receive the paired globals artifact"

CURL_LOG="$TEST_ROOT/curl.log" RESTORE_VERIFY_LOG="$TEST_ROOT/verify.log" \
  run_monitor RUN_RESTORE_VERIFY=1 RESTORE_VERIFY_LOG="$TEST_ROOT/verify.log" FAKE_VERIFY_FAIL=1 \
  >/dev/null 2>&1 \
  && fail "failed restore verification must exit non-zero" \
  || pass "failed restore verification exits non-zero"
grep -q 'restore verification failed' "$TEST_ROOT/curl.log" \
  || fail "failed verification must fire an alert"
pass "RUN_RESTORE_VERIFY=1 runs the verifier and alerts on failure"

if [ "$FAILED" -ne 0 ]; then
  echo "TESTS FAILED" >&2
  exit 1
fi
echo "ALL TESTS PASSED"
