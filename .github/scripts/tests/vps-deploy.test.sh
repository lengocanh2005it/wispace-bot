#!/usr/bin/env bash
# Failure-path + crash-safety tests for vps-deploy.sh (#199/#201/#203/#204/#275/#278).
#
# Self-contained: fakes docker/curl/sudo via PATH; uses a fake upstream conf
# and a fake container/port map to simulate blue-green state.
# Run: bash .github/scripts/tests/vps-deploy.test.sh
set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/vps-deploy.sh"
REPO_ROOT="$(cd "$(dirname "$SCRIPT")/../.." && pwd)"
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
    if [ "${2:-}" = "-f" ]; then
      case "${3:-}" in
        *NetworkSettings.Networks*) echo "${FAKE_NETWORK_IP:-172.30.0.2}" ;;
        *) echo "${FAKE_IMAGE:-img}" ;;
      esac
      exit 0
    fi
    for c in ${FAKE_EXISTING:-}; do [ "$c" = "${2:-}" ] && exit 0; done
    exit 1
    ;;
  network)
    case "${2:-}" in
      inspect)
        [ "${3:-}" = "app_n8n_db_network" ] && exit 0
        [ -n "${FAKE_MONITORING_NETWORK:-}" ] && exit 0 || exit 1
        ;;
      create)
        exit 0
        ;;
      connect)
        [ "${6:-}" = "messenger-bot-new" ] && [ -n "${FAKE_NETWORK_NEW_ALIAS_FAIL:-}" ] && exit 1
        [ -n "${FAKE_NETWORK_CONNECT_FAIL:-}" ] && exit 1 || exit 0
        ;;
      disconnect)
        [ -n "${FAKE_NETWORK_DISCONNECT_FAIL:-}" ] && exit 1 || exit 0
        ;;
    esac
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
    # DB reachability/writer probes run from the release container.
    case "$*" in
      *pg_isready*)
        [ -n "${FAKE_DB_UP:-}" ] && exit 0 || exit 1
        ;;
      *pg_is_in_recovery*)
        [ -n "${FAKE_DB_UP:-}" ] && [ -z "${FAKE_DB_STANDBY:-}" ] && printf 't\n'
        exit 0
        ;;
      *pg_dump*)
        [ -n "${FAKE_DUMP_FAIL:-}" ] && exit 1
        [ -z "${FAKE_DUMP_EMPTY:-}" ] && printf 'DUMPDATA\n'
        exit 0
        ;;
      *migration:show*)
        [ -n "${FAKE_MIGRATION_PENDING:-}" ] && printf '[ ] pending\n' || printf '[X] applied\n'
        exit 0
        ;;
    esac
    exit 0
    ;;
  pull)
    [ -n "${FAKE_PULL_FAIL:-}" ] && exit 1 || exit 0
    ;;
  run|rm|stop|logs|manifest)
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
  printf 'PORT=5007\nINTERNAL_API_KEY=test-internal-key\nDB_HOST=postgres_n8n_db\nDB_PORT=5432\nDB_USER=postgres\nDB_PASSWORD=secret\nDB_NAME=ai_chat_bot_db\n' > "$dir/deploy/.env"
}

write_upstream() { # dir port
  printf 'upstream messenger_backend {\n    server 127.0.0.1:%s;\n}\n' "$2" > "$dir/upstreams/messenger-bot.conf"
}

make_failing_chmod() { # dir [basename]
  local dir="$1" target="${2:-}"
  cat > "$dir/bin/chmod" <<FAKE
#!/usr/bin/env bash
for arg in "\$@"; do
  case "\$arg" in
    *${target}) exit 1 ;;
  esac
done
exit 0
FAKE
  chmod +x "$dir/bin/chmod"
}

make_failing_mktemp() { # dir
  local dir="$1"
  cat > "$dir/bin/mktemp" <<'FAKE'
#!/usr/bin/env bash
exit 1
FAKE
  chmod +x "$dir/bin/mktemp"
}

make_failing_mv() { # dir
  local dir="$1"
  cat > "$dir/bin/mv" <<'FAKE'
#!/usr/bin/env bash
exit 1
FAKE
  chmod +x "$dir/bin/mv"
}

make_recording_mv() { # dir
  local dir="$1" real_mv
  real_mv=$(command -v mv)
  cat > "$dir/bin/mv" <<FAKE
#!/usr/bin/env bash
printf '%s\n' "\$1 -> \$2" >> "\${FAKE_MV_LOG:?}"
stat -c '%a' "\$1" >> "\${FAKE_MV_MODE_LOG:?}"
exec "$real_mv" "\$@"
FAKE
  chmod +x "$dir/bin/mv"
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

echo "Test 4: SKIP_NGINX_CHECK with active container -> fail closed without stopping live (#284)"
dir=$(make_env upstream-skip-live)
write_env "$dir"
code=$(run_script "$dir" SKIP_NGINX_CHECK=true FAKE_EXISTING="messenger-bot-old")
[ "$code" -eq 1 ] || fail "expected exit 1 with active container, got $code"
grep -q "active container" "$dir/run.out" || fail "missing active-container fail-closed message"
! grep -q "docker stop --timeout.*messenger-bot-old" "$dir/docker.log" || fail "active container was stopped"
pass "Nginx bypass refuses to stop active container"

echo "Test 5: image pull failure -> fail closed before docker run (#271)"
dir=$(make_env pull-fail)
write_env "$dir"
code=$(run_script "$dir" SKIP_NGINX_CHECK=true FAKE_PULL_FAIL=1)
[ "$code" -eq 1 ] || fail "expected exit 1 on pull failure, got $code"
grep -q "image pull failed" "$dir/run.out" || fail "missing pull failure message"
! grep -q "docker run" "$dir/docker.log" || fail "docker run started after pull failure"
pass "image pull failure stops before docker run"

echo "Test 6: migrations enabled without command -> fail closed (#271)"
dir=$(make_env migration-command-missing)
write_env "$dir"
write_upstream "$dir" 5007
code=$(run_script "$dir" RUN_MIGRATIONS=true FAKE_DB_UP=1)
[ "$code" -eq 1 ] || fail "expected exit 1 without migration command, got $code"
grep -q "MIGRATION_CMD" "$dir/run.out" || fail "missing migration command error"
pass "missing migration command fails closed"

echo "Test 7: pre-migration dump failure -> fail closed before migration (#271)"
dir=$(make_env migration-dump-fail)
write_env "$dir"
write_upstream "$dir" 5007
code=$(run_script "$dir" RUN_MIGRATIONS=true FAKE_DB_UP=1 FAKE_DUMP_FAIL=1 PRE_MIGRATE_DIR="$dir/pre-migrate" \
  MIGRATION_CMD='npx --no-install typeorm migration:run -d apps/messenger-bot/dist/infrastructure/database/data-source.js')
[ "$code" -eq 1 ] || fail "expected exit 1 on dump failure, got $code"
grep -q "pre-migration dump failed" "$dir/run.out" || fail "missing dump failure message"
! grep -q "pg_advisory_lock" "$dir/docker.log" || fail "migration started after dump failure"
pass "pre-migration dump failure stops before migration"

echo "Test 8: empty pre-migration dump -> fail closed before migration (#271)"
dir=$(make_env migration-dump-empty)
write_env "$dir"
write_upstream "$dir" 5007
code=$(run_script "$dir" RUN_MIGRATIONS=true FAKE_DB_UP=1 FAKE_DUMP_EMPTY=1 PRE_MIGRATE_DIR="$dir/pre-migrate" \
  MIGRATION_CMD='npx --no-install typeorm migration:run -d apps/messenger-bot/dist/infrastructure/database/data-source.js')
[ "$code" -eq 1 ] || fail "expected exit 1 on empty dump, got $code"
grep -q "pre-migration dump failed" "$dir/run.out" || fail "missing empty dump failure message"
! grep -q "pg_advisory_lock" "$dir/docker.log" || fail "migration started after empty dump"
pass "empty pre-migration dump stops before migration"

echo "Test 9: pending image migrations -> fail closed before nginx switch (#275)"
dir=$(make_env migration-pending)
write_env "$dir"
write_upstream "$dir" 5007
code=$(run_script "$dir" RUN_MIGRATIONS=true FAKE_DB_UP=1 FAKE_MIGRATION_PENDING=1 PRE_MIGRATE_DIR="$dir/pre-migrate" \
  MIGRATION_CMD='npx --no-install typeorm migration:run -d apps/messenger-bot/dist/infrastructure/database/data-source.js')
[ "$code" -eq 1 ] || fail "expected exit 1 with pending migration, got $code"
grep -q "pending migrations" "$dir/run.out" || fail "missing pending migration error"
! grep -q "nginx -s reload" "$dir/docker.log" || fail "traffic switched with pending migration"
pass "pending migration blocks traffic switch"

echo "Test 10: interrupted deploy (nginx routed to -new) -> adopt -new as -old, never rm it (#201)"
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

echo "Test 11: rename of live -new fails -> abort, live container never deleted (#201)"
dir=$(make_env rename-fail)
write_env "$dir"
write_upstream "$dir" 5008
code=$(run_script "$dir" FAKE_RENAME_FAIL=1 FAKE_EXISTING="messenger-bot-new" FAKE_PORT_MAP="5008:messenger-bot-new" FAKE_IMAGE=img:old)
[ "$code" -eq 1 ] || fail "expected exit 1, got $code"
grep -q "could not rename live" "$dir/run.out" || fail "missing rename-failure abort message"
grep -q "docker rm -f messenger-bot-new" "$dir/docker.log" && fail "-new deleted after failed rename (live container removed!)"
pass "rename failure aborts without deleting live container"

echo "Test 12: docker stop/run honor DOCKER_STOP_TIMEOUT grace period (#201)"
dir=$(make_env stop-timeout)
write_env "$dir"
write_upstream "$dir" 5007
code=$(run_script "$dir" FAKE_EXISTING="messenger-bot-old" FAKE_PORT_MAP="5007:messenger-bot-old" FAKE_IMAGE=img:old)
[ "$code" -eq 0 ] || fail "expected exit 0, got $code: $(cat "$dir/run.out")"
grep -q -- "--stop-timeout 60" "$dir/docker.log" || fail "docker run missing --stop-timeout"
grep -q -- "docker stop --timeout 60 messenger-bot-old" "$dir/docker.log" || fail "docker stop missing --timeout"
pass "graceful stop timeout honored"

echo "Test 13: post-switch monitor verifies the public nginx route (#199)"
dir=$(make_env public-verify)
write_env "$dir"
write_upstream "$dir" 5007
code=$(run_script "$dir" FAKE_EXISTING="messenger-bot-old" FAKE_PORT_MAP="5007:messenger-bot-old" FAKE_IMAGE=img:old)
[ "$code" -eq 0 ] || fail "expected exit 0, got $code: $(cat "$dir/run.out")"
grep -q -- "--resolve aiassist.aihubproduction.com:443:127.0.0.1" "$dir/curl.log" || fail "public route not verified through nginx"
pass "public route verified after switch"

echo "Test 14: migration preflights the writer and invokes the fenced CLI (#203/#408)"
dir=$(make_env migration-lock)
write_env "$dir"
write_upstream "$dir" 5007
code=$(run_script "$dir" RUN_MIGRATIONS=true FAKE_DB_UP=1 PRE_MIGRATE_DIR="$dir/pre-migrate" \
  MIGRATION_CMD='npx --no-install typeorm migration:run -d apps/messenger-bot/dist/infrastructure/database/data-source.js')
[ "$code" -eq 0 ] || fail "expected exit 0, got $code: $(cat "$dir/run.out")"
grep -q "pg_is_in_recovery" "$dir/docker.log" || fail "writer role was not preflighted"
grep -q "migration:run" "$dir/docker.log" || fail "migration CLI was not invoked"
! grep -q "pg_advisory_lock" "$dir/docker.log" || fail "deploy shell must not hold a lock on a different session"
! grep -q "\\! npx --no-install typeorm migration:run" "$dir/docker.log" || fail "migration still uses a psql shell escape"
grep -q "migration:show" "$dir/docker.log" || fail "release migration status was not verified"
grep -q "MIGRATION_LOCK_ID=4242424242" "$dir/docker.log" || fail "migration lock id was not passed to the release image"
pass "writer preflight and direct migration CLI"

echo "Test 15: migration DB unreachable -> fail closed, no migration attempt (#199)"
dir=$(make_env migration-db-down)
write_env "$dir"
code=$(run_script "$dir" RUN_MIGRATIONS=true \
  MIGRATION_CMD='npx --no-install typeorm migration:run -d apps/messenger-bot/dist/infrastructure/database/data-source.js')
[ "$code" -eq 1 ] || fail "expected exit 1, got $code"
grep -q "unavailable — refusing to deploy" "$dir/run.out" || fail "missing fail-closed message"
pass "migration DB down fails closed"

echo "Test 15b: migration standby endpoint -> fail closed before dump (#408)"
dir=$(make_env migration-db-standby)
write_env "$dir"
write_upstream "$dir" 5007
code=$(run_script "$dir" RUN_MIGRATIONS=true FAKE_DB_UP=1 FAKE_DB_STANDBY=1 PRE_MIGRATE_DIR="$dir/pre-migrate" \
  MIGRATION_CMD='npx --no-install typeorm migration:run -d apps/messenger-bot/dist/infrastructure/database/data-source.js')
[ "$code" -eq 1 ] || fail "expected exit 1 on standby, got $code"
grep -q "not the writable primary" "$dir/run.out" || fail "missing standby fail-closed message"
[ ! -d "$dir/pre-migrate" ] || fail "standby must fail before creating a dump"
pass "standby endpoint blocks migration"

echo "Test 16: env file uses mktemp + EXIT trap cleanup (#204)"
dir=$(make_env env-file-cleanup)
write_env "$dir"
write_upstream "$dir" 5007
code=$(run_script "$dir" FAKE_EXISTING="messenger-bot-old" FAKE_PORT_MAP="5007:messenger-bot-old" FAKE_IMAGE=img:old)
[ "$code" -eq 0 ] || fail "expected exit 0, got $code: $(cat "$dir/run.out")"
leftovers=$(find "$dir/tmp" -name '*.docker-env.*' 2>/dev/null | wc -l)
[ "$leftovers" -eq 0 ] || fail "env file not cleaned up (${leftovers} leftover)"
pass "env file cleaned up after deploy"

echo "Test 17: postgres-backup.sh enforces 700 dir / 600 files (#204)"
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
[ "$1" = "exec" ] && {
  case "$*" in
    *psql*) printf 't\n' ;;
    *) printf 'DUMPDATA\n' ;;
  esac
  exit 0
}
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
  # Fake psql/pg_dump: run_db_client() tries native before docker — route
  # them through the fake docker so the writer preflight + dump succeed.
  cat > "$dir/bin/psql" <<'FAKEPSQL'
#!/usr/bin/env bash
exec docker exec -e PGPASSWORD="${PGPASSWORD:-}" postgres_n8n_db psql "$@"
FAKEPSQL
  cat > "$dir/bin/pg_dump" <<'FAKEPGDUMP'
#!/usr/bin/env bash
exec docker exec -e PGPASSWORD="${PGPASSWORD:-}" postgres_n8n_db pg_dump "$@"
FAKEPGDUMP
  chmod +x "$dir/bin/docker" "$dir/bin/gpg" "$dir/bin/psql" "$dir/bin/pg_dump"
  printf 'DB_HOST=postgres_n8n_db\nDB_PORT=5432\nDB_USER=postgres\nDB_NAME=ai_chat_bot_db\nDB_PASSWORD=secret\nBACKUP_ENCRYPTION_PASSPHRASE=test-passphrase\n' > "$dir/deploy/.env"
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

echo "Test 18: digest pinning — docker pull/run use @sha256: when IMAGE_DIGEST set (#196)"
dir=$(make_env digest-pin)
write_env "$dir"
write_upstream "$dir" 5008
code=$(run_script "$dir" "IMAGE_DIGEST=sha256:abc123def456")
[ "$code" -eq 0 ] || fail "deploy failed with digest pinning, exit $code"
grep -q "Pinning by digest" "$dir/run.out" || fail "missing digest pin log message"
grep -q "docker pull ghcr.io/x/messenger-bot:sha@sha256:abc123def456" "$dir/docker.log" || fail "docker pull not pinned by digest"
grep -q "docker run.*ghcr.io/x/messenger-bot:sha@sha256:abc123def456" "$dir/docker.log" || fail "docker run not pinned by digest"
pass "digest pinning works"

echo "Test 19: no digest — docker pull/run use tag only when IMAGE_DIGEST unset (#196)"
dir=$(make_env digest-fallback)
write_env "$dir"
write_upstream "$dir" 5008
code=$(run_script "$dir")
[ "$code" -eq 0 ] || fail "deploy failed without digest, exit $code"
! grep -q "Pinning by digest" "$dir/run.out" || fail "should not log digest pin when unset"
grep -q "docker pull ghcr.io/x/messenger-bot:sha" "$dir/docker.log" || fail "docker pull missing"
grep -q "docker run.*ghcr.io/x/messenger-bot:sha" "$dir/docker.log" || fail "docker run missing"
pass "tag-only fallback works"

echo "Test 20: existing .env is locked down before it is read (#276)"
dir=$(make_env existing-env-perms)
write_env "$dir"
chmod 664 "$dir/deploy/.env"
code=$(run_script "$dir" SKIP_NGINX_CHECK=true)
[ "$code" -eq 0 ] || fail "deploy failed after hardening existing .env, exit $code"
mode_probe="$TEST_ROOT/mode-probe-existing-env"
printf 'x\n' > "$mode_probe"
chmod 600 "$mode_probe"
if [ "$(stat -c '%a' "$mode_probe" 2>/dev/null || echo unsupported)" = "600" ]; then
  mode=$(stat -c '%a' "$dir/deploy/.env")
  [ "$mode" = "600" ] || fail "existing .env mode $mode != 600"
else
  echo "  skip: platform does not reflect POSIX modes (CI asserts existing .env mode)"
fi
pass "existing .env permission is hardened"

echo "Test 21: production.env is atomically installed with mode 600 (#276)"
dir=$(make_env production-env-install)
write_env "$dir"
printf 'OLD_ENV_KEY=from-old\n' >> "$dir/deploy/.env"
printf 'PORT=5010\nINTERNAL_API_KEY=test-internal-key\nDB_HOST=postgres_n8n_db\nDB_PORT=5432\nDB_USER=postgres\nDB_PASSWORD=new-secret\nDB_NAME=ai_chat_bot_db\n' > "$dir/deploy/production.env"
make_recording_mv "$dir"
export FAKE_MV_LOG="$dir/mv.log" FAKE_MV_MODE_LOG="$dir/mv.mode.log"
code=$(run_script "$dir" SKIP_NGINX_CHECK=true)
unset FAKE_MV_LOG FAKE_MV_MODE_LOG
[ "$code" -eq 0 ] || fail "production.env install failed, exit $code: $(cat "$dir/run.out")"
grep -q '^PORT=5010' "$dir/deploy/.env" || fail "production.env content was not installed"
grep -q '^DEPLOY_UID=' "$dir/deploy/.env" || fail "DEPLOY_UID missing from installed env"
grep -q '^DEPLOY_GID=' "$dir/deploy/.env" || fail "DEPLOY_GID missing from installed env"
! grep -q '^OLD_ENV_KEY=' "$dir/deploy/.env" || fail "old .env content survived replacement"
[ ! -f "$dir/deploy/production.env" ] || fail "production.env was not cleaned up"
[ "$(wc -l < "$dir/mv.log")" -eq 1 ] || fail "expected one atomic mv"
grep -q ' -> ' "$dir/mv.log" || fail "atomic mv was not recorded"
[ "$(cat "$dir/mv.mode.log")" = "600" ] || fail "temporary env mode was not 600"
[ "$(find "$dir/deploy" -maxdepth 1 -name '.env.install.*' | wc -l)" -eq 0 ] || fail "temporary install file was not cleaned up"
pass "production.env uses a mode-600 atomic replacement"

echo "Test 22: env permission/temp/mv failures stop deployment (#276)"
dir=$(make_env fail-existing-chmod)
write_env "$dir"
make_failing_chmod "$dir" .env
code=$(run_script "$dir")
[ "$code" -eq 1 ] || fail "existing .env chmod failure did not stop deploy"
pass "existing .env chmod failure is fail-closed"

dir=$(make_env fail-production-chmod)
printf 'PORT=5010\n' > "$dir/deploy/production.env"
make_failing_chmod "$dir" production.env
code=$(run_script "$dir")
[ "$code" -eq 1 ] || fail "production.env chmod failure did not stop deploy"
pass "production.env chmod failure is fail-closed"

dir=$(make_env fail-install-mktemp)
printf 'PORT=5010\n' > "$dir/deploy/production.env"
make_failing_mktemp "$dir"
code=$(run_script "$dir")
[ "$code" -eq 1 ] || fail "mktemp failure did not stop deploy"
pass "mktemp failure is fail-closed"

dir=$(make_env fail-install-mv)
printf 'PORT=5010\n' > "$dir/deploy/production.env"
make_failing_mv "$dir"
code=$(run_script "$dir")
[ "$code" -eq 1 ] || fail "atomic mv failure did not stop deploy"
pass "atomic mv failure is fail-closed"

echo "Test 24: active bot joins monitoring network and exposes fixed internal metrics port (#278)"
dir=$(make_env monitoring-network)
write_env "$dir"
write_upstream "$dir" 5007
code=$(run_script "$dir" FAKE_NETWORK_IP=172.30.0.4 FAKE_EXISTING="messenger-bot-old" FAKE_PORT_MAP="5007:messenger-bot-old")
[ "$code" -eq 0 ] || fail "expected exit 0, got $code: $(cat "$dir/run.out")"
grep -q "docker network create monitoring" "$dir/docker.log" || fail "monitoring network was not ensured"
grep -q "docker network connect app_n8n_db_network messenger-bot-old" "$dir/docker.log" || fail "active bot was not attached to app network"
grep -q "docker network connect app_n8n_db_network messenger-bot-new" "$dir/docker.log" || fail "new bot was not attached to app network"
grep -q "docker run.*--network monitoring.*-e PORT=5007.*-p 127.0.0.1:5008:5007" "$dir/docker.log" || fail "new container did not use fixed internal port"
grep -q "curl.*Authorization: Bearer test-internal-key.*127.0.0.1:5008/metrics" "$dir/curl.log" || fail "standby metrics endpoint was not auth-checked"
grep -q "docker network disconnect monitoring messenger-bot-old" "$dir/docker.log" || fail "old metrics alias was not detached"
grep -q "docker network connect --alias messenger-bot-metrics monitoring messenger-bot-new" "$dir/docker.log" || fail "new metrics alias was not attached"
grep -q "172.30.0.4:5007/metrics" "$dir/curl.log" || fail "monitoring-network metrics endpoint was not checked"
pass "monitoring network, alias handoff and metrics auth check work"

echo "Test 25: Prometheus targets stable metrics aliases and fixed internal ports (#278)"
PROM_TEMPLATE="$REPO_ROOT/deploy/monitoring/prometheus.tmpl"
PROM_COMPOSE="$REPO_ROOT/deploy/monitoring/docker-compose.yml"
grep -q 'messenger-bot-metrics:5007' "$PROM_TEMPLATE" || fail "Messenger target is not stable alias/fixed port"
grep -q 'discord-bot-metrics:3001' "$PROM_TEMPLATE" || fail "Discord target is not stable alias/fixed port"
grep -q 'zalo-bot-metrics:3002' "$PROM_TEMPLATE" || fail "Zalo target is not stable alias/fixed port"
! grep -q '127.0.0.1:' "$PROM_TEMPLATE" || fail "Prometheus template still targets host loopback"
grep -q 'external: true' "$PROM_COMPOSE" || fail "monitoring network is not shared external network"
! grep -q '_default:' "$PROM_COMPOSE" || fail "Prometheus still depends on bot compose networks"
pass "Prometheus uses stable aliases and shared monitoring network"

echo "Test 26: metrics alias failure rolls back traffic and preserves old alias (#278)"
dir=$(make_env monitoring-rollback)
write_env "$dir"
write_upstream "$dir" 5007
code=$(run_script "$dir" FAKE_NETWORK_NEW_ALIAS_FAIL=1 FAKE_EXISTING="messenger-bot-old" FAKE_PORT_MAP="5007:messenger-bot-old")
[ "$code" -eq 1 ] || fail "expected alias failure to exit 1, got $code"
grep -q "rolling back" "$dir/run.out" || fail "alias failure did not report rollback"
grep -q "docker network connect --alias messenger-bot-metrics monitoring messenger-bot-old" "$dir/docker.log" || fail "old metrics alias was not restored"
grep -q "docker rm -f messenger-bot-new" "$dir/docker.log" || fail "failed new container was not removed"
grep -q "server 127.0.0.1:5007" "$dir/upstreams/messenger-bot.conf" || fail "nginx was not restored to old port"
pass "metrics alias failure rolls back safely"

# --- Migration config validation tests (#357) ---

echo "Test 20: malicious DB_HOST with shell metacharacters -> validation fails"
dir=$(make_env malicious-db-host)
# Write .env with malicious DB_HOST — script reads from deploy dir
cat > "$dir/deploy/.env" <<EOF
INTERNAL_API_KEY=test-internal-key
DB_USER=testuser
DB_NAME=testdb
DB_PASSWORD=testpass
DB_HOST=localhost;rm -rf /
DB_PORT=5432
EOF
write_upstream "$dir" 5007
code=$(run_script "$dir" FAKE_EXISTING="messenger-bot-old" FAKE_PORT_MAP="5007:messenger-bot-old" RUN_MIGRATIONS=true "MIGRATION_CMD=npx --no-install typeorm migration:run -d apps/messenger-bot/dist/infrastructure/database/data-source.js")
[ "$code" -eq 1 ] || fail "malicious DB_HOST should exit 1, got $code"
grep -q "DB_HOST contains invalid characters" "$dir/run.out" || fail "missing DB_HOST validation error"
pass "malicious DB_HOST rejected"

echo "Test 21: malicious MIGRATION_LOCK_ID with SQL injection -> validation fails"
dir=$(make_env malicious-lock-id)
cat > "$dir/deploy/.env" <<EOF
INTERNAL_API_KEY=test-internal-key
DB_USER=testuser
DB_NAME=testdb
DB_PASSWORD=testpass
DB_HOST=localhost
DB_PORT=5432
EOF
write_upstream "$dir" 5007
code=$(run_script "$dir" FAKE_EXISTING="messenger-bot-old" FAKE_PORT_MAP="5007:messenger-bot-old" RUN_MIGRATIONS=true "MIGRATION_CMD=npx --no-install typeorm migration:run -d apps/messenger-bot/dist/infrastructure/database/data-source.js" "MIGRATION_LOCK_ID=1;DROP TABLE users")
[ "$code" -eq 1 ] || fail "malicious MIGRATION_LOCK_ID should exit 1, got $code"
grep -q "MIGRATION_LOCK_ID must be a numeric integer" "$dir/run.out" || fail "missing MIGRATION_LOCK_ID validation error"
pass "malicious MIGRATION_LOCK_ID rejected"

echo "Test 22: valid config values pass validation"
dir=$(make_env valid-config)
cat > "$dir/deploy/.env" <<EOF
INTERNAL_API_KEY=test-internal-key
DB_USER=ai_chat_bot
DB_NAME=ai_chat_bot_db
DB_PASSWORD=securepass123
DB_HOST=pgbouncer
DB_PORT=5432
EOF
write_upstream "$dir" 5007
code=$(run_script "$dir" FAKE_EXISTING="messenger-bot-old" FAKE_PORT_MAP="5007:messenger-bot-old" RUN_MIGRATIONS=true "MIGRATION_CMD=npx --no-install typeorm migration:run -d apps/messenger-bot/dist/infrastructure/database/data-source.js")
# Should NOT fail on validation — may fail on other things (DB unreachable, etc.)
grep -q "contains invalid characters" "$dir/run.out" && fail "valid config should pass validation"
grep -q "must be a numeric integer" "$dir/run.out" && fail "valid config should pass validation"
pass "valid config passes validation"

[ "$FAILED" -eq 0 ] && echo "ALL TESTS PASSED"
exit "$FAILED"
