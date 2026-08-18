#!/usr/bin/env bash
# Failure-path + crash-safety tests for vps-deploy.sh (#199/#201/#203/#204).
#
# Self-contained: fakes docker/curl/sudo via PATH; uses a fake upstream conf
# and a fake container/port map to simulate blue-green state.
# Run: bash .github/scripts/tests/vps-deploy.test.sh
set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/vps-deploy.sh"
BACKUP_SCRIPT="$(cd "$(dirname "$0")/../../.." && pwd)/deploy/postgres-backup.sh"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

FAILED=0

fail() { echo "FAIL: $1" >&2; FAILED=1; }
pass() { echo "  ok: $1"; }

make_fake_bin() { # dir
  local dir="$1"
  cat > "$dir/docker" <<'FAKE'
#!/usr/bin/env bash
echo "docker $*" >> "${DOCKER_LOG:?}"
case "$1" in
  inspect)
    [ "${2:-}" = "-f" ] && { echo "${FAKE_IMAGE:-img}"; exit 0; }
    for c in ${FAKE_EXISTING:-}; do [ "$c" = "${2:-}" ] && exit 0; done
    exit 1
    ;;
  ps)
    # docker ps --filter publish=PORT (or publish=IP:PORT) --format '{{.Names}}'
    port=$(printf '%s' "$*" | grep -oE 'publish=(127\.0\.0\.1:)?[0-9]+' | grep -oE '[0-9]+$' || true)
    for pair in ${FAKE_PORT_MAP:-}; do
      p=${pair%%:*}; n=${pair#*:}
      [ "$p" = "$port" ] && echo "$n"
    done
    exit 0
    ;;
  port)
    for pair in ${FAKE_PORT_MAP:-}; do
      p=${pair%%:*}; n=${pair#*:}
      [ "$n" = "${2:-}" ] && { echo "127.0.0.1:$p"; exit 0; }
    done
    exit 0
    ;;
  exec)
    # DB reachability probe: `docker exec <db> pg_isready ...`
    case "$*" in
      *pg_isready*)
        [ -n "${FAKE_DB_UP:-}" ] && exit 0 || exit 1
        ;;
    esac
    exit 0
    ;;
  run|rm|stop|pull|logs|manifest)
    exit 0
    ;;
  rename)
    [ -n "${FAKE_RENAME_FAIL:-}" ] && exit 1 || exit 0
    ;;
esac
FAKE
  cat > "$dir/curl" <<'FAKE'
#!/usr/bin/env bash
echo "curl $*" >> "${CURL_LOG:?}"
exit 0
FAKE
  cat > "$dir/sudo" <<'FAKE'
#!/usr/bin/env bash
echo "sudo $*" >> "${SUDO_LOG:?}"
exit 0
FAKE
  cat > "$dir/stat" <<'FAKE'
#!/usr/bin/env bash
# Git Bash/MSYS does not reflect POSIX modes (chmod 600 looks like 755);
# CI (Ubuntu) uses the real stat, where the mode check is exercised for real.
echo 600
FAKE
  chmod +x "$dir/docker" "$dir/curl" "$dir/sudo" "$dir/stat"
}

make_env() { # name -> creates dirs + fakes; prints dir
  local dir="$TEST_ROOT/$1"
  mkdir -p "$dir/deploy" "$dir/upstreams" "$dir/bin" "$dir/tmp"
  make_fake_bin "$dir/bin"
  echo "$dir"
}

run_script() { # dir [EXTRA_ENV=..].. -> echoes exit code
  local dir="$1"; shift
  (
    cd "$dir/deploy"
    export APP_NAME=messenger-bot IMAGE=ghcr.io/x/messenger-bot:sha \
      DEPLOY_MODE=self-pull NGINX_UPSTREAM_DIR="$dir/upstreams" \
      TMPDIR="$dir/tmp" HEALTH_PATH=/health/ready POST_SWITCH_MONITOR_ATTEMPTS=2 \
      POST_SWITCH_MONITOR_INTERVAL=0 RUN_MIGRATIONS=false \
      DOCKER_LOG="$dir/docker.log" CURL_LOG="$dir/curl.log" SUDO_LOG="$dir/sudo.log" \
      PATH="$dir/bin:$PATH"
    for extra in "$@"; do export "$extra"; done
    bash "$SCRIPT"
  ) > "$dir/run.out" 2>&1
  echo $?
}

write_env() { # dir -> minimal .env
  printf 'PORT=5007\nDB_HOST=postgres_n8n_db\nDB_PORT=5432\nDB_USER=postgres\nDB_PASSWORD=secret\nDB_NAME=ai_chat_bot_db\n' > "$dir/deploy/.env"
}

write_upstream() { # dir port
  printf 'upstream messenger_backend {\n    server 127.0.0.1:%s;\n}\n' "$2" > "$dir/upstreams/messenger-bot.conf"
}

# --- tests -------------------------------------------------------------------
echo "Test 1: missing .env -> fail closed (exit 1), no docker run (#199)"
dir=$(make_env env-missing)
code=$(run_script "$dir")
[ "$code" -eq 1 ] || fail "expected exit 1, got $code"
grep -q "No .env file found" "$dir/run.out" || fail "missing ERROR message"
[ ! -f "$dir/docker.log" ] || fail "docker must not run without env"
pass "missing .env fails closed"

echo "Test 2: upstream conf missing -> fail closed (exit 1) unless SKIP_NGINX_CHECK (#199)"
dir=$(make_env upstream-missing)
write_env "$dir"
FAKE_EXISTING= FAKE_PORT_MAP= code=$(run_script "$dir")
[ "$code" -eq 1 ] || fail "expected exit 1 without SKIP_NGINX_CHECK, got $code"
grep -q "refusing to cut over without nginx" "$dir/run.out" || fail "missing fail-closed message"
pass "missing upstream conf fails closed"

echo "Test 3: SKIP_NGINX_CHECK=true -> deploy proceeds on standby port monitor (#199)"
dir=$(make_env upstream-skip)
write_env "$dir"
FAKE_EXISTING= FAKE_PORT_MAP= code=$(run_script "$dir" SKIP_NGINX_CHECK=true)
[ "$code" -eq 0 ] || fail "expected exit 0, got $code: $(cat "$dir/run.out")"
grep -q "SKIP_NGINX_CHECK=true" "$dir/run.out" || fail "missing skip warning"
pass "SKIP_NGINX_CHECK escape hatch works"

echo "Test 4: interrupted deploy (nginx routed to -new) -> adopt -new as -old, never rm it (#201)"
dir=$(make_env crash-recover)
write_env "$dir"
write_upstream "$dir" 5008
code=$(run_script "$dir" FAKE_EXISTING="messenger-bot-new messenger-bot-old" FAKE_PORT_MAP="5008:messenger-bot-new 5007:messenger-bot-old" FAKE_IMAGE=img:old)
[ "$code" -eq 0 ] || fail "expected exit 0, got $code: $(cat "$dir/run.out")"
grep -q "adopting it as messenger-bot-old" "$dir/run.out" || fail "live -new not adopted"
rename_line=$(grep -n "docker rename messenger-bot-new messenger-bot-old" "$dir/docker.log" | head -1 | cut -d: -f1)
rm_new_line=$(grep -n "docker rm -f messenger-bot-new" "$dir/docker.log" | head -1 | cut -d: -f1)
[ -n "$rename_line" ] || fail "rename to -old never called"
[ -n "$rm_new_line" ] && [ "$rename_line" -lt "$rm_new_line" ] || fail "-new removed before/without adoption"
pass "live -new adopted, not deleted"

echo "Test 5: rename of live -new fails -> abort, live container never deleted (#201)"
dir=$(make_env rename-fail)
write_env "$dir"
write_upstream "$dir" 5008
code=$(run_script "$dir" FAKE_RENAME_FAIL=1 FAKE_EXISTING="messenger-bot-new" FAKE_PORT_MAP="5008:messenger-bot-new" FAKE_IMAGE=img:old)
[ "$code" -eq 1 ] || fail "expected exit 1, got $code"
grep -q "could not rename live" "$dir/run.out" || fail "missing rename-failure abort message"
grep -q "docker rm -f messenger-bot-new" "$dir/docker.log" && fail "-new deleted after failed rename (live container removed!)"
pass "rename failure aborts without deleting live container"

echo "Test 6: docker stop/run honor DOCKER_STOP_TIMEOUT grace period (#201)"
dir=$(make_env stop-timeout)
write_env "$dir"
write_upstream "$dir" 5007
code=$(run_script "$dir" FAKE_EXISTING="messenger-bot-old" FAKE_PORT_MAP="5007:messenger-bot-old" FAKE_IMAGE=img:old)
[ "$code" -eq 0 ] || fail "expected exit 0, got $code: $(cat "$dir/run.out")"
grep -q -- "--stop-timeout 60" "$dir/docker.log" || fail "docker run missing --stop-timeout"
grep -q -- "docker stop --timeout 60 messenger-bot-old" "$dir/docker.log" || fail "docker stop missing --timeout"
pass "graceful stop timeout honored"

echo "Test 7: post-switch monitor verifies the public nginx route (#199)"
dir=$(make_env public-verify)
write_env "$dir"
write_upstream "$dir" 5007
code=$(run_script "$dir" FAKE_EXISTING="messenger-bot-old" FAKE_PORT_MAP="5007:messenger-bot-old" FAKE_IMAGE=img:old)
[ "$code" -eq 0 ] || fail "expected exit 0, got $code: $(cat "$dir/run.out")"
grep -q -- "--resolve aiassist.aihubproduction.com:443:127.0.0.1" "$dir/curl.log" || fail "public route not verified through nginx"
pass "public route verified after switch"

echo "Test 8: migration runs inside one psql session with the advisory lock (#203)"
dir=$(make_env migration-lock)
write_env "$dir"
write_upstream "$dir" 5007
code=$(run_script "$dir" RUN_MIGRATIONS=true FAKE_DB_UP=1 PRE_MIGRATE_DIR="$dir/pre-migrate" \
  MIGRATION_CMD='npx --no-install typeorm migration:run -d apps/messenger-bot/dist/infrastructure/database/data-source.js')
[ "$code" -eq 0 ] || fail "expected exit 0, got $code: $(cat "$dir/run.out")"
grep -q "pg_advisory_lock" "$dir/docker.log" || fail "lock not acquired via psql"
grep -q "pg_advisory_unlock" "$dir/docker.log" || fail "lock not released via psql"
grep -q "\\! npx --no-install typeorm migration:run" "$dir/docker.log" || fail "migration not run via psql \! escape"
lock_count=$(grep -c "pg_advisory_lock" "$dir/docker.log" || true)
[ "$lock_count" -eq 1 ] || fail "expected exactly 1 lock acquisition (same session), got $lock_count"
pass "advisory lock held on the migration session"

echo "Test 9: migration DB unreachable -> fail closed, no migration attempt (#199)"
dir=$(make_env migration-db-down)
write_env "$dir"
code=$(run_script "$dir" RUN_MIGRATIONS=true \
  MIGRATION_CMD='npx --no-install typeorm migration:run -d apps/messenger-bot/dist/infrastructure/database/data-source.js')
[ "$code" -eq 1 ] || fail "expected exit 1, got $code"
grep -q "unavailable — refusing to deploy" "$dir/run.out" || fail "missing fail-closed message"
pass "migration DB down fails closed"

echo "Test 10: env file uses mktemp + EXIT trap cleanup (#204)"
dir=$(make_env env-file-cleanup)
write_env "$dir"
write_upstream "$dir" 5007
code=$(run_script "$dir" FAKE_EXISTING="messenger-bot-old" FAKE_PORT_MAP="5007:messenger-bot-old" FAKE_IMAGE=img:old)
[ "$code" -eq 0 ] || fail "expected exit 0, got $code: $(cat "$dir/run.out")"
leftovers=$(find "$dir/tmp" -name '*.docker-env.*' 2>/dev/null | wc -l)
[ "$leftovers" -eq 0 ] || fail "env file not cleaned up (${leftovers} leftover)"
pass "env file cleaned up after deploy"

echo "Test 11: postgres-backup.sh enforces 700 dir / 600 files (#204)"
# Git Bash/MSYS on Windows does not reflect POSIX mode bits through chmod/stat
# (chmod only marks read-only) — skip the mode assertions there; CI runs on
# Ubuntu where modes are real.
probe="$TEST_ROOT/mode-probe"
mkdir -p "$probe"
chmod 700 "$probe"
if [ "$(stat -c '%a' "$probe" 2>/dev/null)" = "700" ]; then
  dir=$(make_env backup-perms)
  mkdir -p "$dir/bin"
  cat > "$dir/bin/docker" <<'FAKE'
#!/usr/bin/env bash
[ "$1" = "exec" ] && { printf 'DUMPDATA\n'; exit 0; }
exit 1
FAKE
  # Fake gpg: just copy input to output (no real encryption in tests)
  cat > "$dir/bin/gpg" <<'FAKEGPG'
#!/usr/bin/env bash
INFILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --output) shift; OUTFILE="$1"; shift;;
    --passphrase|--cipher-algo) shift; shift;;
    --*) shift;;
    *) INFILE="$1"; shift;;
  esac
done
cp "$INFILE" "$OUTFILE"
FAKEGPG
  chmod +x "$dir/bin/docker" "$dir/bin/gpg"
  printf 'DB_USER=postgres\nDB_NAME=ai_chat_bot_db\nDB_PASSWORD=secret\nBACKUP_ENCRYPTION_PASSPHRASE=test-passphrase\n' > "$dir/deploy/.env"
  (
    export ENV_FILE="$dir/deploy/.env" BACKUP_DIR="$dir/backups" DB_CONTAINER=postgres_n8n_db \
      PATH="$dir/bin:$PATH"
    bash "$BACKUP_SCRIPT"
  ) > "$dir/backup.out" 2>&1
  [ $? -eq 0 ] || fail "backup failed: $(cat "$dir/backup.out")"
  dir_mode=$(stat -c '%a' "$dir/backups")
  [ "$dir_mode" = "700" ] || fail "backup dir mode $dir_mode != 700"
  dump=$(find "$dir/backups" -name '*.sql.gz.gpg' | head -1)
  [ -n "$dump" ] || fail "no backup file produced"
  file_mode=$(stat -c '%a' "$dump")
  [ "$file_mode" = "600" ] || fail "backup file mode $file_mode != 600"
  pass "backup dir/files locked down"
else
  echo "  skip: platform does not reflect POSIX modes (CI Ubuntu asserts)"
fi

[ "$FAILED" -eq 0 ] && echo "ALL TESTS PASSED"
exit "$FAILED"
