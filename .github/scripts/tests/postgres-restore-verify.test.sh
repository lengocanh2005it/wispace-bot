#!/usr/bin/env bash
# Guarded PostgreSQL restore-verify path tests (#865, #879).
# Self-contained: fakes docker/gpg/gzip/psql/getent via PATH; no real Postgres.
# Covers: prod-target rejection, non-allowlisted staging rejection, missing
# artifacts, wrong-key / corrupt-archive failure with failure evidence,
# interrupted cleanup, empty/partial/stale restore detection, sidecar extra
# entries (warn), row-floor violation, staging freshness + TLS + alias-to-prod
# isolation + sanitized globals, evidence collision-resistance + retention,
# and a successful isolated restore with retained evidence.
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
out=""
prev=""
for arg in "$@"; do
  [ "$prev" = "--output" ] && out="$arg"
  prev="$arg"
done
[ -n "$out" ] || exit 0
case "$out" in
  *state.json.gz) cat "${FAKE_STATE_SRC:?}" > "$out" ;;
  *globals.sql.gz) cat "${FAKE_GLOBALS_SRC:?}" > "$out" ;;
  *) printf 'FAKEGZPAYLOAD\n' > "$out" ;;
esac
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
prev=""
for arg in "$@"; do
  if [ "$prev" = "-f" ] && [ -f "$arg" ]; then
    cat "$arg" >> "${PSQL_FILE_LOG:-/dev/null}"
    echo >> "${PSQL_FILE_LOG:-/dev/null}"
  fi
  prev="$arg"
done
env | grep -E '^PGSSL' >> "${PSQL_ENV_LOG:-/dev/null}" 2>/dev/null || true
q="$*"
case "$q" in
  *FROM\ pg_roles*)
    if [ "${FAKE_ROLES+set}" = "set" ]; then printf '%s\n' "$FAKE_ROLES" | tr ',' '\n'; fi
    exit 0 ;;
  *FROM\ public.migrations*)
    [ -n "${FAKE_PSQL_FAIL:-}" ] && exit 1
    if [ "${FAKE_MIGS+set}" = "set" ]; then printf '%s\n' "$FAKE_MIGS" | tr ':' '\n'; else printf 'mig1\nmig2\nmig3\n'; fi
    exit 0 ;;
  *ORDER\ BY\ table_name*)
    if [ "${FAKE_TABLES+set}" = "set" ]; then printf '%s\n' "$FAKE_TABLES" | tr ':' '\n'; else printf 'migrations\nuser_platform_mappings\nchat_daily_usage\n'; fi
    exit 0 ;;
  *FROM\ pg_database*)
    echo "${FAKE_DB_EXISTS:-1}"; exit 0 ;;
  *BASE\ TABLE*)
    echo "${FAKE_PRE_TABLES:-0}"; exit 0 ;;
  *FROM\ public.*)
    [ -n "${FAKE_PSQL_FAIL:-}" ] && exit 1
    echo "${FAKE_ROW_COUNT:-5}"; exit 0 ;;
esac
exit 0
FAKE

cat > "$FAKE_BIN/getent" <<'FAKE'
#!/usr/bin/env bash
echo "getent $*" >> "${GETENT_LOG:-/dev/null}"
host="${2:-}"
case "$host" in
  prod-db.example.com) echo "10.9.9.9	prod-db.example.com" ;;
  staging-db.internal)
    if [ -n "${FAKE_ALIAS_TO_PROD:-}" ]; then
      echo "10.9.9.9	staging-db.internal"
    elif [ -n "${FAKE_STAGING_UNRESOLVED:-}" ]; then
      exit 2
    else
      echo "10.0.0.10	staging-db.internal"
    fi ;;
  *) exit 2 ;;
esac
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
STATE="$TEST_ROOT/ai_chat_bot_db-20260908-020000.state.json.gz.gpg"
printf 'enc-dump' > "$ARTIFACT"
printf 'enc-globals' > "$GLOBALS"
printf 'enc-state' > "$STATE"

STATE_JSON_OK='{"sidecar_version": 1, "captured_at": "2026-09-08T02:00:00Z", "migrations": ["mig1", "mig2", "mig3"], "tables": ["migrations", "user_platform_mappings", "chat_daily_usage"]}'
STATE_JSON_EMPTY='{"sidecar_version": 1, "captured_at": "2026-09-08T02:00:00Z", "migrations": [], "tables": ["migrations"]}'
STATE_JSON_NOVERSION='{"captured_at": "2026-09-08T02:00:00Z", "migrations": ["mig1"], "tables": ["migrations"]}'
GLOBALS_SQL_OK='CREATE ROLE "prod_admin" LOGIN PASSWORD '"'"'md5secret'"'"' SUPERUSER;
CREATE ROLE "restorer" LOGIN;
ALTER ROLE "prod_admin" WITH LOGIN SUPERUSER;
ALTER ROLE "restorer" WITH SUPERUSER;
GRANT ALL ON DATABASE ai_chat_bot_db TO "prod_admin";
COMMENT ON ROLE "prod_admin" IS '"'"'prod admin'"'"';'

echo "$STATE_JSON_OK" > "$TEST_ROOT/state-ok.json"
echo "$STATE_JSON_EMPTY" > "$TEST_ROOT/state-empty.json"
echo "$STATE_JSON_NOVERSION" > "$TEST_ROOT/state-noversion.json"
printf '%s' "$GLOBALS_SQL_OK" > "$TEST_ROOT/globals-ok.sql"

# Default fake-payload sources: fake gpg materializes these artifacts; the
# per-case runs below may override FAKE_STATE_SRC (e.g. the unusable sidecar).
export FAKE_STATE_SRC="$TEST_ROOT/state-ok.json"
export FAKE_GLOBALS_SRC="$TEST_ROOT/globals-ok.sql"

run_verify() { # <evidence-dir> <args...>
  local evidence_dir="$1"
  shift
  DOCKER_LOG="$TEST_ROOT/docker.log" GPG_LOG="$TEST_ROOT/gpg.log" \
    GETENT_LOG="$TEST_ROOT/getent.log" \
    PATH="$FAKE_BIN:$PATH" bash "$SCRIPT" "$@" 2>&1
}

assert_no_passphrase_in_logs() {
  ! grep -q 'backup-pass' "$TEST_ROOT/docker.log" "$TEST_ROOT/gpg.log" 2>/dev/null
}

COMMON_ARGS=(--artifact "$ARTIFACT" --globals-artifact "$GLOBALS" --state-artifact "$STATE"
  --env-file "$PROD_ENV" --passphrase-file "$PROD_ENV")

# --- 1. Production target rejection -----------------------------------------
OUT_EVID="$TEST_ROOT/ev1"
DOCKER_LOG="$TEST_ROOT/docker.log" GPG_LOG="$TEST_ROOT/gpg.log" \
  FAKE_STATE_SRC="$TEST_ROOT/state-ok.json" FAKE_GLOBALS_SRC="$TEST_ROOT/globals-ok.sql" \
  PATH="$FAKE_BIN:$PATH" bash "$SCRIPT" "${COMMON_ARGS[@]}" \
  --evidence-dir "$OUT_EVID" \
  --target staging --target-host prod-db.example.com --target-port 5432 \
  --target-db other_db --target-user restorer \
  >/dev/null 2>"$TEST_ROOT/err1" \
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
  RESTORE_TARGET_CA="$TEST_ROOT/ca.pem" bash "$SCRIPT" "${COMMON_ARGS[@]}" \
  --evidence-dir "$TEST_ROOT/ev2" \
  --target staging --target-host evil.internal --target-port 5432 \
  --target-db staging_db --target-user restorer \
  >/dev/null 2>&1 \
  && fail "non-allowlisted staging target must be rejected" \
  || pass "non-allowlisted staging target rejected"
[ -s "$TEST_ROOT/gpg.log" ] && fail "no gpg call may happen before allowlist validation"

# --- 3. Missing artifacts fail closed -----------------------------------------
for missing in globals state; do
  case "$missing" in
    globals) args=(--artifact "$ARTIFACT" --state-artifact "$STATE") ;;
    state)   args=(--artifact "$ARTIFACT" --globals-artifact "$GLOBALS") ;;
  esac
  DOCKER_LOG="$TEST_ROOT/docker.log" GPG_LOG="$TEST_ROOT/gpg.log" \
    PATH="$FAKE_BIN:$PATH" bash "$SCRIPT" "${args[@]}" \
    --env-file "$PROD_ENV" --evidence-dir "$TEST_ROOT/ev3-$missing" --target disposable \
    --passphrase-file "$PROD_ENV" >/dev/null 2>"$TEST_ROOT/err3-$missing" \
    && fail "missing $missing artifact must fail closed" \
    || pass "missing $missing artifact fails closed"
  grep -qi "$missing" "$TEST_ROOT/err3-$missing" || fail "error must mention missing $missing"
done

# --- 4. Wrong key / gpg failure → non-zero + failure evidence ------------------
EVID4="$TEST_ROOT/ev4"
DOCKER_LOG="$TEST_ROOT/docker.log" GPG_LOG="$TEST_ROOT/gpg.log" \
  PATH="$FAKE_BIN:$PATH" FAKE_GPG_FAIL=1 bash "$SCRIPT" "${COMMON_ARGS[@]}" \
  --evidence-dir "$EVID4" --target disposable \
  >/dev/null 2>&1 \
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
  PATH="$FAKE_BIN:$PATH" FAKE_GZIP_CORRUPT=1 bash "$SCRIPT" "${COMMON_ARGS[@]}" \
  --evidence-dir "$EVID5" --target disposable \
  >/dev/null 2>&1 \
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
  PATH="$FAKE_BIN:$PATH" FAKE_PG_NOT_READY=1 bash "$SCRIPT" "${COMMON_ARGS[@]}" \
  --evidence-dir "$TEST_ROOT/ev6" --target disposable \
  >/dev/null 2>&1 \
  && fail "unready database must fail the run" \
  || true
sleep 0.2
AFTER_COUNT=$(find "$TMP_PARENT" -mindepth 1 -maxdepth 1 -type d | wc -l)
[ "$AFTER_COUNT" -eq "$BEFORE_COUNT" ] || fail "temp plaintext dir must be removed on failure"
! find "$TMP_PARENT" -name '*.sql' -o -name '*.gz' | grep -q . \
  || fail "no plaintext sql/gz files may survive a failed run"
pass "failed run leaves no plaintext temp material"

# --- 7. #879: empty restore detected against the sidecar -----------------------
EVID7="$TEST_ROOT/ev7"
DOCKER_LOG="$TEST_ROOT/docker.log" GPG_LOG="$TEST_ROOT/gpg.log" \
  PATH="$FAKE_BIN:$PATH" FAKE_MIGS="" bash "$SCRIPT" "${COMMON_ARGS[@]}" \
  --evidence-dir "$EVID7" --target disposable \
  >/dev/null 2>"$TEST_ROOT/err7" \
  && fail "empty restore must fail against the sidecar" \
  || pass "empty restore fails closed"
grep -qi 'missing sidecar entries' "$TEST_ROOT/err7" \
  || fail "empty restore error must name the missing sidecar entries"

# --- 8. #879: partial restore (missing table) detected -------------------------
EVID8="$TEST_ROOT/ev8"
DOCKER_LOG="$TEST_ROOT/docker.log" GPG_LOG="$TEST_ROOT/gpg.log" \
  PATH="$FAKE_BIN:$PATH" FAKE_TABLES="migrations:user_platform_mappings" bash "$SCRIPT" \
  "${COMMON_ARGS[@]}" --evidence-dir "$EVID8" --target disposable \
  >/dev/null 2>"$TEST_ROOT/err8" \
  && fail "partial restore must fail against the sidecar" \
  || pass "partial restore fails closed"
grep -qi 'restored tables are missing sidecar entries' "$TEST_ROOT/err8" \
  || fail "partial restore error must name the missing tables"

# --- 9. #879: stale migration state detected -----------------------------------
EVID9="$TEST_ROOT/ev9"
DOCKER_LOG="$TEST_ROOT/docker.log" GPG_LOG="$TEST_ROOT/gpg.log" \
  PATH="$FAKE_BIN:$PATH" FAKE_MIGS="mig1" bash "$SCRIPT" \
  "${COMMON_ARGS[@]}" --evidence-dir "$EVID9" --target disposable \
  >/dev/null 2>"$TEST_ROOT/err9" \
  && fail "stale migration state must fail against the sidecar" \
  || pass "stale migration state fails closed"
grep -qi 'mig2' "$TEST_ROOT/err9" || fail "stale-state error must name the missing migration"

# --- 10. #879: extra restored entries warn but pass -----------------------------
EVID10="$TEST_ROOT/ev10"
OUT10=$(DOCKER_LOG="$TEST_ROOT/docker.log" GPG_LOG="$TEST_ROOT/gpg.log" \
  PATH="$FAKE_BIN:$PATH" FAKE_MIGS="mig1:mig2:mig3:mig4-extra" bash "$SCRIPT" \
  "${COMMON_ARGS[@]}" --evidence-dir "$EVID10" --target disposable) \
  || fail "extra restored entries must not fail the run: $OUT10"
EV10_FILE=$(find "$EVID10" -name '*.json' | head -1)
grep -q '"status": *"warn"' "$EV10_FILE" \
  || fail "extra restored entries must be recorded as warn in evidence"
grep -q '"result": *"success"' "$EV10_FILE" \
  || fail "extra-entry run must still succeed"
pass "extra restored entries warn without failing"

# --- 11. #879: row floor violation detected -------------------------------------
EVID11="$TEST_ROOT/ev11"
DOCKER_LOG="$TEST_ROOT/docker.log" GPG_LOG="$TEST_ROOT/gpg.log" \
  PATH="$FAKE_BIN:$PATH" RESTORE_VERIFY_MIN_ROWS="user_platform_mappings:10" bash "$SCRIPT" \
  "${COMMON_ARGS[@]}" --evidence-dir "$EVID11" --target disposable \
  >/dev/null 2>"$TEST_ROOT/err11" \
  && fail "row floor violation must fail the run" \
  || pass "row floor violation fails closed"
grep -qi 'row floor violated' "$TEST_ROOT/err11" \
  || fail "row floor error must explain the violation"

# --- 12. #879: unusable sidecar (no migrations) fails closed ---------------------
EVID12="$TEST_ROOT/ev12"
DOCKER_LOG="$TEST_ROOT/docker.log" GPG_LOG="$TEST_ROOT/gpg.log" \
  PATH="$FAKE_BIN:$PATH" FAKE_STATE_SRC="$TEST_ROOT/state-empty.json" bash "$SCRIPT" \
  "${COMMON_ARGS[@]}" --evidence-dir "$EVID12" --target disposable \
  >/dev/null 2>"$TEST_ROOT/err12" \
  && fail "sidecar without migrations must fail closed" \
  || pass "unusable sidecar fails closed"
grep -qi 'records no migrations' "$TEST_ROOT/err12" \
  || fail "error must name the unusable sidecar"

# --- 12b. #879: sidecar without a version field fails closed ----------------------
EVID12B="$TEST_ROOT/ev12b"
DOCKER_LOG="$TEST_ROOT/docker.log" GPG_LOG="$TEST_ROOT/gpg.log" \
  PATH="$FAKE_BIN:$PATH" FAKE_STATE_SRC="$TEST_ROOT/state-noversion.json" bash "$SCRIPT" \
  "${COMMON_ARGS[@]}" --evidence-dir "$EVID12B" --target disposable \
  >/dev/null 2>"$TEST_ROOT/err12b" \
  && fail "unversioned sidecar must fail closed" \
  || pass "unversioned sidecar fails closed"
grep -qi 'unsupported version' "$TEST_ROOT/err12b" \
  || fail "error must name the unsupported sidecar version"

# --- 13. #879: staging requires TLS CA -------------------------------------------
EVID13="$TEST_ROOT/ev13"
DOCKER_LOG="$TEST_ROOT/docker.log" GPG_LOG="$TEST_ROOT/gpg.log" \
  PATH="$FAKE_BIN:$PATH" RESTORE_VERIFY_ALLOWLIST="staging-db.internal:staging_db" \
  bash "$SCRIPT" "${COMMON_ARGS[@]}" --evidence-dir "$EVID13" \
  --target staging --target-host staging-db.internal --target-port 5432 \
  --target-db staging_db --target-user restorer \
  >/dev/null 2>"$TEST_ROOT/err13" \
  && fail "staging without RESTORE_TARGET_CA must fail closed" \
  || pass "staging TLS CA is mandatory"
grep -qi 'RESTORE_TARGET_CA' "$TEST_ROOT/err13" || fail "error must name the missing CA"

# --- 14. #879: alias-to-production resolution rejected ----------------------------
touch "$TEST_ROOT/ca.pem"
EVID14="$TEST_ROOT/ev14"
rm -f "$TEST_ROOT/gpg14.log"
DOCKER_LOG="$TEST_ROOT/docker14.log" GPG_LOG="$TEST_ROOT/gpg14.log" GETENT_LOG="$TEST_ROOT/getent.log" \
  PATH="$FAKE_BIN:$PATH" FAKE_ALIAS_TO_PROD=1 \
  RESTORE_VERIFY_ALLOWLIST="staging-db.internal:staging_db" RESTORE_TARGET_CA="$TEST_ROOT/ca.pem" \
  bash "$SCRIPT" "${COMMON_ARGS[@]}" --evidence-dir "$EVID14" \
  --target staging --target-host staging-db.internal --target-port 5432 \
  --target-db staging_db --target-user restorer \
  >/dev/null 2>"$TEST_ROOT/err14" \
  && fail "staging host aliasing a production IP must be rejected" \
  || pass "alias-to-production staging target rejected"
grep -qi 'production IP' "$TEST_ROOT/err14" \
  || fail "error must name the production IP collision"
[ -s "$TEST_ROOT/gpg14.log" ] && fail "no gpg call may happen after a failed isolation check"

# --- 15. #879: unresolved staging host is ambiguous → fail closed -----------------
EVID15="$TEST_ROOT/ev15"
DOCKER_LOG="$TEST_ROOT/docker.log" GPG_LOG="$TEST_ROOT/gpg.log" \
  PATH="$FAKE_BIN:$PATH" FAKE_STAGING_UNRESOLVED=1 \
  RESTORE_VERIFY_ALLOWLIST="staging-db.internal:staging_db" RESTORE_TARGET_CA="$TEST_ROOT/ca.pem" \
  bash "$SCRIPT" "${COMMON_ARGS[@]}" --evidence-dir "$EVID15" \
  --target staging --target-host staging-db.internal --target-port 5432 \
  --target-db staging_db --target-user restorer \
  >/dev/null 2>"$TEST_ROOT/err15" \
  && fail "unresolved staging host must fail closed" \
  || pass "ambiguous staging target fails closed"
grep -qi 'did not resolve' "$TEST_ROOT/err15" \
  || fail "error must name the unresolved target"

# --- 16. #879: non-empty staging rejected -----------------------------------------
EVID16="$TEST_ROOT/ev16"
PSQL_LOG="$TEST_ROOT/psql16.log" DOCKER_LOG="$TEST_ROOT/docker.log" GPG_LOG="$TEST_ROOT/gpg.log" \
  PATH="$FAKE_BIN:$PATH" FAKE_PRE_TABLES=3 \
  RESTORE_VERIFY_ALLOWLIST="staging-db.internal:staging_db" RESTORE_TARGET_CA="$TEST_ROOT/ca.pem" \
  RESTORE_TARGET_PASSWORD=stage-pass bash "$SCRIPT" "${COMMON_ARGS[@]}" --evidence-dir "$EVID16" \
  --target staging --target-host staging-db.internal --target-port 5432 \
  --target-db staging_db --target-user restorer \
  >/dev/null 2>"$TEST_ROOT/err16" \
  && fail "non-empty staging must be rejected" \
  || pass "non-empty staging target rejected"
grep -qi 'not empty' "$TEST_ROOT/err16" \
  || fail "error must name the non-empty staging target"

# --- 17. #879: staging success — fresh + TLS + sanitized globals --------------------
EVID17="$TEST_ROOT/ev17"
DOCKER17_LOG="$TEST_ROOT/docker17.log"
PSQL_LOG="$TEST_ROOT/psql17.log" PSQL_FILE_LOG="$TEST_ROOT/psql17-files.log" \
  PSQL_ENV_LOG="$TEST_ROOT/psql17-env.log" DOCKER_LOG="$DOCKER17_LOG" \
  GPG_LOG="$TEST_ROOT/gpg17.log" \
  PATH="$FAKE_BIN:$PATH" FAKE_ROLES="restorer,postgres" \
  RESTORE_VERIFY_ALLOWLIST="staging-db.internal:staging_db" RESTORE_TARGET_CA="$TEST_ROOT/ca.pem" \
  RESTORE_TARGET_PASSWORD=stage-pass bash "$SCRIPT" "${COMMON_ARGS[@]}" --evidence-dir "$EVID17" \
  --target staging --target-host staging-db.internal --target-port 5432 \
  --target-db staging_db --target-user restorer \
  >/dev/null 2>"$TEST_ROOT/err17" \
  || fail "staging success run must exit 0: $(cat "$TEST_ROOT/err17")"

grep -q 'verify-full' "$TEST_ROOT/psql17-env.log" \
  || fail "staging psql calls must enforce sslmode=verify-full"
grep -q "$TEST_ROOT/ca.pem" "$TEST_ROOT/psql17-env.log" \
  || fail "staging psql calls must pin the CA bundle (PGSSLROOTCERT)"
grep -q 'staging_fresh' "$EVID17"/*.json || { ls "$EVID17"; fail "evidence must include the staging_fresh check"; }
FILTERED=$(cat "$TEST_ROOT/psql17-files.log")
printf '%s' "$FILTERED" | grep -q 'CREATE ROLE "restorer"' \
  && fail "existing staging roles must not be re-created (idempotent globals)"
printf '%s' "$FILTERED" | grep -Eq 'ALTER ROLE "restorer".*NOSUPERUSER' \
  || fail "existing allowlisted roles must be normalized to NOSUPERUSER"
printf '%s' "$FILTERED" | grep -q 'PASSWORD' \
  && fail "sanitized globals must not contain passwords"
printf '%s' "$FILTERED" | grep -q 'prod_admin' \
  && fail "sanitized globals must drop non-allowlisted production roles"
printf '%s' "$FILTERED" | grep -q 'GRANT' \
  && fail "sanitized globals must drop ACL statements"
grep -q 'docker run' "$DOCKER17_LOG" 2>/dev/null \
  && fail "staging run must not start a disposable container"
pass "staging run is fresh, TLS-enforced, and globals-sanitized"

# --- 18. Successful isolated restore + retained evidence -----------------------------
EVID18="$TEST_ROOT/ev18"
OUT=$(run_verify "$EVID18" "${COMMON_ARGS[@]}" --evidence-dir "$EVID18" --target disposable) \
  || fail "successful disposable restore must exit 0: $OUT"

EV18_FILE=$(find "$EVID18" -name '*.json' | head -1)
[ -n "$EV18_FILE" ] || fail "success run must retain evidence JSON"
grep -q '"result": *"success"' "$EV18_FILE" || fail "evidence must record success"
grep -q '"artifact_sha256"' "$EV18_FILE" || fail "evidence must pin artifact sha256"
grep -q '"state_sha256"' "$EV18_FILE" || fail "evidence must pin state sidecar sha256"
grep -q '"duration_seconds"' "$EV18_FILE" || fail "evidence must record duration"
grep -q '"name": *"state_migrations"' "$EV18_FILE" || fail "evidence must include the migration-state check"
grep -q '"name": *"state_tables"' "$EV18_FILE" || fail "evidence must include the table-state check"
grep -q '"name": *"min_rows"' "$EV18_FILE" || fail "evidence must include the row-floor check"
grep -q 'backup-pass' "$EV18_FILE" && fail "evidence must not contain the passphrase"
DOCKER_LOG="$TEST_ROOT/docker.log" assert_no_passphrase_in_logs \
  || fail "passphrase leaked into fake logs"
grep -q 'docker run' "$TEST_ROOT/docker.log" || fail "disposable mode must start its own container"
grep -q 'docker rm' "$TEST_ROOT/docker.log" || fail "disposable container must be removed"
grep -q 'prod-db.example.com' "$TEST_ROOT/docker.log" \
  && fail "disposable run must never touch the production host"
pass "successful isolated restore with retained evidence"

AFTER18=$(find "$TMP_PARENT" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)
[ "$AFTER18" -eq "$BEFORE_COUNT" ] || fail "success run must also clean plaintext temp"

# --- 19. #879: evidence filename is collision-resistant ------------------------------
EV18_BASE=$(basename "$EV18_FILE")
printf '%s' "$EV18_BASE" | grep -Eq '^restore-verify-[0-9]{8}-[0-9]{6}-[0-9a-f]+\.json$' \
  || fail "evidence filename must carry a random hex suffix: $EV18_BASE"
pass "evidence filename is collision-resistant"

# --- 20. #879: evidence retention prunes old runs -------------------------------------
EVID20="$TEST_ROOT/ev20"
mkdir -p "$EVID20"
OLD_EV="$EVID20/restore-verify-20250101-000000-deadbeef.json"
echo '{"result": "success"}' > "$OLD_EV"
touch -m -d '40 days ago' "$OLD_EV"
run_verify "$EVID20" "${COMMON_ARGS[@]}" --evidence-dir "$EVID20" --target disposable >/dev/null 2>&1 \
  || fail "retention run must succeed"
[ -f "$OLD_EV" ] && fail "evidence older than the retention window must be pruned"
NEW_COUNT=$(find "$EVID20" -name 'restore-verify-*.json' | wc -l)
[ "$NEW_COUNT" -eq 1 ] || fail "retention must keep the fresh evidence file"
pass "evidence retention prunes old runs"

# --- 21. Backup script contract: globals dump + state sidecar + passphrase-fd ---------
grep -q 'pg_dumpall' "$BACKUP_SCRIPT" \
  || fail "backup script must capture PostgreSQL globals (roles)"
grep -q -- '--globals-only' "$BACKUP_SCRIPT" \
  || fail "globals capture must use pg_dumpall --globals-only"
grep -q 'FROM public.migrations' "$BACKUP_SCRIPT" \
  || fail "backup script must capture the migration inventory for the state sidecar (#879)"
grep -q 'state.json.gz.gpg' "$BACKUP_SCRIPT" \
  || fail "backup script must write the encrypted state sidecar (#879)"
grep -q 'table_type=.BASE TABLE.' "$BACKUP_SCRIPT" \
  || fail "backup script must capture the public-table inventory for the state sidecar (#879)"
! grep -Eq -- '--passphrase( |=)"?\$' "$BACKUP_SCRIPT" \
  || fail "backup script must not pass the passphrase via argv"
grep -q -- '--passphrase-fd' "$BACKUP_SCRIPT" \
  || fail "backup script must hand the passphrase over a file descriptor"
grep -q -- '--passphrase-fd' "$SCRIPT" \
  || fail "restore verifier must hand the passphrase over a file descriptor"
grep -q -- '--state-artifact' "$SCRIPT" \
  || fail "restore verifier must require the state sidecar (#879)"
grep -q 'RESTORE_TARGET_CA' "$SCRIPT" \
  || fail "restore verifier must enforce TLS for staging targets (#879)"
grep -q 'getent' "$SCRIPT" \
  || fail "restore verifier must resolve staging targets away from production (#879)"
pass "backup/restore passphrase + globals + state-sidecar contract holds"

if [ "$FAILED" -ne 0 ]; then
  echo "TESTS FAILED" >&2
  exit 1
fi
echo "ALL TESTS PASSED"
