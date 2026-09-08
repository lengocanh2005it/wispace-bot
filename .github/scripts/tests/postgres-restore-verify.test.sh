#!/usr/bin/env bash
# Guarded PostgreSQL restore-verify path tests (#865).
# Self-contained: fakes docker/gpg/gzip via PATH; no real Postgres needed.
# Covers: prod-target rejection, non-allowlisted staging rejection, missing
# globals artifact, wrong-key / corrupt-archive failure with failure evidence,
# interrupted cleanup, and a successful isolated restore with retained evidence.
# Run: bash .github/scripts/tests/postgres-restore-verify.test.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SCRIPT="$ROOT/deploy/postgres-restore-verify.sh"
BACKUP_SCRIPT="$ROOT/deploy/postgres-backup.sh"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

FAILED=0
fail() { echo "FAIL: $1" >&2; FAILED=1; }
pass() { echo "  ok: $1"; }

[ -f "$SCRIPT" ] || { echo "FAIL: $SCRIPT missing" >&2; exit 1; }
[ -f "$BACKUP_SCRIPT" ] || { echo "FAIL: $BACKUP_SCRIPT missing" >&2; exit 1; }

FAKE_BIN="$TEST_ROOT/bin"
mkdir -p "$FAKE_BIN"

cat > "$FAKE_BIN/docker" <<'FAKE'
#!/usr/bin/env bash
echo "docker $*" >> "${DOCKER_LOG:?}"
case "$1" in
  run) echo "fake-container-id"; exit 0 ;;
  port) echo "0.0.0.0:55432"; exit 0 ;;
  exec)
    case "$*" in
      *pg_isready*) [ -n "${FAKE_PG_NOT_READY:-}" ] && exit 1 || exit 0 ;;
      *information_schema.tables*) echo "42" ;;
      *FROM\ public.migrations*) echo "7" ;;
      *to_regclass*) echo "t" ;;
      *FROM\ public.*) echo "3" ;;
      *) echo "1" ;;
    esac
    exit 0 ;;
  stop|rm|logs) exit 0 ;;
esac
exit 0
FAKE

cat > "$FAKE_BIN/gpg" <<'FAKE'
#!/usr/bin/env bash
echo "gpg $*" >> "${GPG_LOG:?}"
if printf '%s' "$*" | grep -Eq -- '--passphrase( |$)|--passphrase='; then
  echo "PASSPHRASE IN ARGV" >&2
  exit 3
fi
[ -n "${FAKE_GPG_FAIL:-}" ] && exit 1
cat >/dev/null # consume the passphrase on stdin
out=""
prev=""
for arg in "$@"; do
  [ "$prev" = "--output" ] && out="$arg"
  prev="$arg"
done
[ -n "$out" ] && printf 'FAKEGZPAYLOAD\n' > "$out"
exit 0
FAKE

cat > "$FAKE_BIN/gzip" <<'FAKE'
#!/usr/bin/env bash
case "$1" in
  *t*) [ -n "${FAKE_GZIP_CORRUPT:-}" ] && exit 1 || exit 0 ;;
  *d*|*c*) cat "${@:2}" ;;
  *) cat >"${@: -1}" ;;
esac
exit 0
FAKE

cat > "$FAKE_BIN/psql" <<'FAKE'
#!/usr/bin/env bash
echo "psql $*" >> "${PSQL_LOG:-/dev/null}"
for arg in "$@"; do
  case "$arg" in
    *WHERE\ missing) echo "0"; exit 0 ;;
    *information_schema.tables*) echo "42"; exit 0 ;;
    *FROM\ public.migrations*) echo "7"; exit 0 ;;
    *to_regclass*) echo "t"; exit 0 ;;
    *FROM\ public.*) echo "3"; exit 0 ;;
  esac
done
exit 0
FAKE

cat > "$FAKE_BIN/gunzip" <<'FAKE'
#!/usr/bin/env bash
cat
FAKE

chmod +x "$FAKE_BIN"/*

PROD_ENV="$TEST_ROOT/prod.env"
cat > "$PROD_ENV" <<'ENV'
DB_HOST=prod-db.example.com
DB_NAME=ai_chat_bot_db
DB_PASSWORD=prod-secret
BACKUP_ENCRYPTION_PASSPHRASE=backup-pass
ENV

ARTIFACT="$TEST_ROOT/ai_chat_bot_db-20260908-020000.sql.gz.gpg"
GLOBALS="$TEST_ROOT/ai_chat_bot_db-20260908-020000.globals.sql.gz.gpg"
printf 'enc-dump' > "$ARTIFACT"
printf 'enc-globals' > "$GLOBALS"

run_verify() { # <evidence-dir> <args...>
  local evidence_dir="$1"
  shift
  DOCKER_LOG="$TEST_ROOT/docker.log" GPG_LOG="$TEST_ROOT/gpg.log" \
    PATH="$FAKE_BIN:$PATH" bash "$SCRIPT" "$@" 2>&1
}

assert_no_passphrase_in_logs() {
  ! grep -q 'backup-pass' "$TEST_ROOT/docker.log" "$TEST_ROOT/gpg.log" 2>/dev/null
}

# --- 1. Production target rejection -----------------------------------------
OUT_EVID="$TEST_ROOT/ev1"
DOCKER_LOG="$TEST_ROOT/docker.log" GPG_LOG="$TEST_ROOT/gpg.log" \
  PATH="$FAKE_BIN:$PATH" bash "$SCRIPT" \
  --artifact "$ARTIFACT" --globals-artifact "$GLOBALS" \
  --env-file "$PROD_ENV" --evidence-dir "$OUT_EVID" \
  --target staging --target-host prod-db.example.com --target-port 5432 \
  --target-db other_db --target-user restorer \
  --passphrase-file "$PROD_ENV" >/dev/null 2>"$TEST_ROOT/err1" \
  && fail "prod-host staging target must be rejected" \
  || pass "prod-host staging target rejected"

grep -qi 'production\|prod' "$TEST_ROOT/err1" \
  || fail "rejection reason must name the production conflict"
[ -s "$TEST_ROOT/gpg.log" ] && fail "no gpg call may happen before target validation"
DOCKER_LOG="$TEST_ROOT/docker.log" assert_no_passphrase_in_logs \
  || fail "passphrase leaked into fake logs"
pass "no gpg/secret use on prod-target rejection"

# --- 2. Non-allowlisted staging target rejection ------------------------------
DOCKER_LOG="$TEST_ROOT/docker.log" GPG_LOG="$TEST_ROOT/gpg.log" \
  PATH="$FAKE_BIN:$PATH" RESTORE_VERIFY_ALLOWLIST="staging-db.internal:staging_db" \
  bash "$SCRIPT" \
  --artifact "$ARTIFACT" --globals-artifact "$GLOBALS" \
  --env-file "$PROD_ENV" --evidence-dir "$TEST_ROOT/ev2" \
  --target staging --target-host evil.internal --target-port 5432 \
  --target-db staging_db --target-user restorer \
  --passphrase-file "$PROD_ENV" >/dev/null 2>&1 \
  && fail "non-allowlisted staging target must be rejected" \
  || pass "non-allowlisted staging target rejected"
[ -s "$TEST_ROOT/gpg.log" ] && fail "no gpg call may happen before allowlist validation"

# --- 3. Missing globals artifact fail-closed ----------------------------------
DOCKER_LOG="$TEST_ROOT/docker.log" GPG_LOG="$TEST_ROOT/gpg.log" \
  PATH="$FAKE_BIN:$PATH" bash "$SCRIPT" \
  --artifact "$ARTIFACT" --env-file "$PROD_ENV" \
  --evidence-dir "$TEST_ROOT/ev3" --target disposable \
  --passphrase-file "$PROD_ENV" >/dev/null 2>"$TEST_ROOT/err3" \
  && fail "missing globals artifact must fail closed" \
  || pass "missing globals artifact fails closed"
grep -qi 'globals' "$TEST_ROOT/err3" || fail "error must mention missing globals"

# --- 4. Wrong key / gpg failure → non-zero + failure evidence ------------------
EVID4="$TEST_ROOT/ev4"
DOCKER_LOG="$TEST_ROOT/docker.log" GPG_LOG="$TEST_ROOT/gpg.log" \
  PATH="$FAKE_BIN:$PATH" FAKE_GPG_FAIL=1 bash "$SCRIPT" \
  --artifact "$ARTIFACT" --globals-artifact "$GLOBALS" \
  --env-file "$PROD_ENV" --evidence-dir "$EVID4" --target disposable \
  --passphrase-file "$PROD_ENV" >/dev/null 2>&1 \
  && fail "gpg failure must exit non-zero" \
  || pass "wrong-key decrypt failure exits non-zero"

EV4_FILE=$(find "$EVID4" -name '*.json' 2>/dev/null | head -1)
[ -n "$EV4_FILE" ] || fail "failure run must retain evidence JSON"
grep -q '"result": *"failure"' "$EV4_FILE" || fail "failure evidence must record result=failure"
grep -q 'backup-pass' "$EV4_FILE" && fail "evidence must not contain the passphrase"
pass "failure evidence retained without secrets"

# --- 5. Corrupt archive → non-zero --------------------------------------------
EVID5="$TEST_ROOT/ev5"
DOCKER_LOG="$TEST_ROOT/docker.log" GPG_LOG="$TEST_ROOT/gpg.log" \
  PATH="$FAKE_BIN:$PATH" FAKE_GZIP_CORRUPT=1 bash "$SCRIPT" \
  --artifact "$ARTIFACT" --globals-artifact "$GLOBALS" \
  --env-file "$PROD_ENV" --evidence-dir "$EVID5" --target disposable \
  --passphrase-file "$PROD_ENV" >/dev/null 2>&1 \
  && fail "corrupt gzip must exit non-zero" \
  || pass "corrupt archive exits non-zero"
EV5_FILE=$(find "$EVID5" -name '*.json' 2>/dev/null | head -1)
[ -n "$EV5_FILE" ] && grep -q '"result": *"failure"' "$EV5_FILE" \
  || fail "corrupt-archive run must retain failure evidence"

# --- 6. Interrupted run cleans plaintext temp ---------------------------------
TMP_PARENT="$TEST_ROOT/tmphome"
mkdir -p "$TMP_PARENT"
BEFORE_COUNT=$(find "$TMP_PARENT" -mindepth 1 -maxdepth 1 -type d | wc -l)
DOCKER_LOG="$TEST_ROOT/docker.log" GPG_LOG="$TEST_ROOT/gpg.log" TMPDIR="$TMP_PARENT" \
  PATH="$FAKE_BIN:$PATH" FAKE_PG_NOT_READY=1 bash "$SCRIPT" \
  --artifact "$ARTIFACT" --globals-artifact "$GLOBALS" \
  --env-file "$PROD_ENV" --evidence-dir "$TEST_ROOT/ev6" --target disposable \
  --passphrase-file "$PROD_ENV" >/dev/null 2>&1 \
  && fail "unready database must fail the run" \
  || true
sleep 0.2
AFTER_COUNT=$(find "$TMP_PARENT" -mindepth 1 -maxdepth 1 -type d | wc -l)
[ "$AFTER_COUNT" -eq "$BEFORE_COUNT" ] || fail "temp plaintext dir must be removed on failure"
! find "$TMP_PARENT" -name '*.sql' -o -name '*.gz' | grep -q . \
  || fail "no plaintext sql/gz files may survive a failed run"
pass "failed run leaves no plaintext temp material"

# --- 7. Successful isolated restore + retained evidence ------------------------
EVID7="$TEST_ROOT/ev7"
OUT=$(run_verify "$EVID7" \
  --artifact "$ARTIFACT" --globals-artifact "$GLOBALS" \
  --env-file "$PROD_ENV" --evidence-dir "$EVID7" --target disposable \
  --passphrase-file "$PROD_ENV") || fail "successful disposable restore must exit 0: $OUT"

EV7_FILE=$(find "$EVID7" -name '*.json' | head -1)
[ -n "$EV7_FILE" ] || fail "success run must retain evidence JSON"
grep -q '"result": *"success"' "$EV7_FILE" || fail "evidence must record success"
grep -q '"artifact_sha256"' "$EV7_FILE" || fail "evidence must pin artifact sha256"
grep -q '"duration_seconds"' "$EV7_FILE" || fail "evidence must record duration"
grep -q '"name": *"migrations"' "$EV7_FILE" || fail "evidence must include migration check"
grep -q '"name": *"row_counts"' "$EV7_FILE" || fail "evidence must include row-count check"
grep -q 'backup-pass' "$EV7_FILE" && fail "evidence must not contain the passphrase"
DOCKER_LOG="$TEST_ROOT/docker.log" assert_no_passphrase_in_logs \
  || fail "passphrase leaked into fake logs"
grep -q 'docker run' "$TEST_ROOT/docker.log" || fail "disposable mode must start its own container"
grep -q 'docker rm' "$TEST_ROOT/docker.log" || fail "disposable container must be removed"
grep -q 'prod-db.example.com' "$TEST_ROOT/docker.log" \
  && fail "disposable run must never touch the production host"
pass "successful isolated restore with retained evidence"

AFTER7=$(find "$TMP_PARENT" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)
[ "$AFTER7" -eq "$BEFORE_COUNT" ] || fail "success run must also clean plaintext temp"

# --- 8. Backup script contract: globals dump + passphrase-fd -------------------
grep -q 'pg_dumpall' "$BACKUP_SCRIPT" \
  || fail "backup script must capture PostgreSQL globals (roles)"
grep -q -- '--globals-only' "$BACKUP_SCRIPT" \
  || fail "globals capture must use pg_dumpall --globals-only"
! grep -Eq -- '--passphrase( |=)"?\$' "$BACKUP_SCRIPT" \
  || fail "backup script must not pass the passphrase via argv"
grep -q -- '--passphrase-fd' "$BACKUP_SCRIPT" \
  || fail "backup script must hand the passphrase over a file descriptor"
grep -q -- '--passphrase-fd' "$SCRIPT" \
  || fail "restore verifier must hand the passphrase over a file descriptor"
pass "backup/restore passphrase + globals contract holds"

if [ "$FAILED" -ne 0 ]; then
  echo "TESTS FAILED" >&2
  exit 1
fi
echo "ALL TESTS PASSED"
