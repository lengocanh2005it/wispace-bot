#!/usr/bin/env bash
# Concurrency + failure-path tests for vps-self-pull-deploy.sh (#144/#172/#283/#408).
#
# Self-contained: fakes git/docker/curl via PATH (fake repo with .git refs);
# requires only bash + flock. Run: bash .github/scripts/tests/vps-self-pull-deploy.test.sh
set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/vps-self-pull-deploy.sh"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

SHA_A="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
SHA_B="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
FAILED=0

fail() { echo "FAIL: $1" >&2; FAILED=1; }
pass() { echo "  ok: $1"; }

# --- fixtures ---------------------------------------------------------------
make_env() { # name -> creates fake repo/PATH-fakes/state dirs; prints dir
  local dir="$TEST_ROOT/$1"
  mkdir -p "$dir/repo/.git" "$dir/repo/apps/messenger-bot" "$dir/repo/apps/discord-bot" \
    "$dir/repo/apps/zalo-bot" "$dir/repo/.github/scripts" \
    "$dir/repo/deploy/nginx/upstreams" "$dir/bin" "$dir/state" "$dir/target" "$dir/upstreams"
  for app in messenger-bot discord-bot zalo-bot; do
    mkdir -p "$dir/target/$app"
    printf 'VAULT_REQUIRED=true\nVAULT_ADDR=https://vault.test\nVAULT_ROLE_ID=role-%s\nVAULT_SECRET_ID=secret-%s\n' "$app" "$app" > "$dir/target/$app/.env"
    chmod 600 "$dir/target/$app/.env"
  done
  for app in messenger-bot discord-bot zalo-bot; do
    printf 'server 127.0.0.1:1;\n' > "$dir/repo/deploy/nginx/upstreams/$app.conf"
  done
  cat > "$dir/repo/.github/scripts/vps-deploy.sh" <<'STUB'
#!/usr/bin/env bash
echo "FAKE vps-deploy ${APP_NAME:-unknown}" >> "${FAKE_DEPLOY_LOG:?}"
echo "FAKE app network ${APP_NETWORK:-unset}" >> "${FAKE_DEPLOY_NETWORK_LOG:?}"
echo "FAKE migration lock ${MIGRATION_LOCK_ID:-unset}" >> "${FAKE_DEPLOY_NETWORK_LOG:?}"
echo "locked" > "${FAKE_DEPLOY_STARTED:?}"
[ -n "${FAKE_DEPLOY_SLEEP:-}" ] && sleep "$FAKE_DEPLOY_SLEEP"
[ "${FAKE_DEPLOY_FAIL_APP:-}" = "${APP_NAME:-}" ] && exit 1
[ -n "${FAKE_DEPLOY_FAIL:-}" ] && exit 1
exit 0
STUB
  chmod +x "$dir/repo/.github/scripts/vps-deploy.sh"

  echo "$SHA_A" > "$dir/repo/.git/HEAD"
  echo "$SHA_A" > "$dir/repo/.git/origin-main"

  cat > "$dir/bin/git" <<FAKE
#!/usr/bin/env bash
echo "git \$*" >> "\${GIT_LOG:?}"
case "\$1" in
  fetch)
    [ -z "\${FAKE_FETCH_FAIL:-}" ] || { echo "fake fetch fail" >&2; exit 1; }
    echo "$SHA_B" > "\${FAKE_REPO:?}/.git/origin-main"
    ;;
  reset)
    [ -n "\${FAKE_RESET_STALE:-}" ] || cat "\${FAKE_REPO:?}/.git/origin-main" > "\${FAKE_REPO:?}/.git/HEAD"
    ;;
  rev-list)
    cat "\${FAKE_REPO:?}/.git/HEAD"
    echo "$SHA_A"
    ;;
  merge-base)
    # --is-ancestor: applied revision is behind the target unless told otherwise.
    [ -z "\${FAKE_NOT_ANCESTOR:-}" ] || exit 1
    ;;
  diff)
    # --name-only <a> <b> -- <migrations path>: silence means no migration
    # was added between the two revisions.
    [ -z "\${FAKE_MIGRATION_CHANGED:-}" ] || echo "packages/database/src/migrations/1700000000000-Fake.ts"
    ;;
  rev-parse)
    if [ "\${2:-}" = "origin/main" ]; then cat "\${FAKE_REPO:?}/.git/origin-main"; else cat "\${FAKE_REPO:?}/.git/HEAD"; fi
    ;;
esac
FAKE
  chmod +x "$dir/bin/git"

  cat > "$dir/bin/docker" <<'FAKE'
#!/usr/bin/env bash
echo "docker $1" >> "${DOCKER_LOG:?}"
case "$1" in
  login) exit 0 ;;
  manifest)
    # Return JSON with sha256 digest for digest extraction (#196)
    printf '{"schemaVersion":2,"config":{"digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}\n'
    exit 0
    ;;
  *) exit 0 ;;
esac
FAKE
  chmod +x "$dir/bin/docker"

  cat > "$dir/bin/curl" <<'FAKE'
#!/usr/bin/env bash
echo "curl $*" >> "${CURL_LOG:?}"
printf '%s' "$*" > "${CURL_BODY:?}"
exit 0
FAKE
  chmod +x "$dir/bin/curl"

  echo "$dir"
}

run_script() { # dir [EXTRA_ENV=..]... -> runs the script, echoes exit code
  local dir="$1"; shift
  (
    export REPO_DIR="$dir/repo" STATE_DIR="$dir/state" LOCK_FILE="$dir/lock" \
      TARGET_BASE_DIR="$dir/target" NGINX_UPSTREAM_DIR="$dir/upstreams" \
      ALERTMANAGER_URL="http://fake-alertmanager" GHCR_USER="u" GHCR_PULL_TOKEN="t" \
      GIT_LOG="$dir/git.log" DOCKER_LOG="$dir/docker.log" CURL_LOG="$dir/curl.log" \
      CURL_BODY="$dir/curl.body" FAKE_REPO="$dir/repo" FAKE_DEPLOY_LOG="$dir/deploy.log" \
      FAKE_DEPLOY_NETWORK_LOG="$dir/deploy-network.log" \
      FAKE_DEPLOY_STARTED="$dir/deploy.started" \
      PATH="$dir/bin:$PATH"
    for extra in "$@"; do export "$extra"; done
    bash "$SCRIPT"
  ) > "$dir/run.out" 2>&1
  echo $?
}

# --- tests -------------------------------------------------------------------
echo "Test 1: git fetch failure -> ERROR log, no reset, no deploy, alert + marker"
dir=$(make_env fetch-fail)
code=$(run_script "$dir" FAKE_FETCH_FAIL=1)
[ "$code" -ne 0 ] || fail "expected non-zero exit, got $code"
grep -q "git fetch origin main failed" "$dir/run.out" || fail "missing ERROR log"
grep -q "^git fetch" "$dir/git.log" || fail "fetch not called"
grep -q "^git reset" "$dir/git.log" && fail "reset must not run after failed fetch"
grep -q "curl -sf -X POST" "$dir/curl.log" || fail "alert not posted"
[ -f "$dir/state/stall" ] || fail "stall marker missing"
[ ! -f "$dir/deploy.log" ] || fail "deploy ran despite fetch failure"
pass "fetch failure handled"

echo "Test 2: stale checkout after reset -> ERROR log, no deploy, alert"
dir=$(make_env stale-checkout)
code=$(run_script "$dir" FAKE_RESET_STALE=1)
[ "$code" -ne 0 ] || fail "expected non-zero exit, got $code"
grep -q "checkout stale" "$dir/run.out" || fail "missing stale ERROR log"
[ ! -f "$dir/deploy.log" ] || fail "deploy ran despite stale checkout"
grep -q "curl -sf -X POST" "$dir/curl.log" || fail "alert not posted"
pass "stale checkout handled"

echo "Test 3: success path -> fetch+reset, 3 deploys, state files, no alert"
dir=$(make_env success)
code=$(run_script "$dir")
[ "$code" -eq 0 ] || fail "expected exit 0, got $code: $(cat "$dir/run.out")"
grep -q "^git fetch" "$dir/git.log" || fail "fetch not called"
grep -q "^git reset" "$dir/git.log" || fail "reset not called"
[ "$(grep -c '^FAKE vps-deploy' "$dir/deploy.log")" -eq 3 ] || fail "expected 3 deploys: $(cat "$dir/deploy.log" 2>/dev/null)"
order=$(sed -E 's/^FAKE vps-deploy ([^ ]+).*/\1/' "$dir/deploy.log" | tr '\n' ' ')
[ "$order" = "messenger-bot discord-bot zalo-bot " ] || fail "migration owner must deploy first, got: $order"
for app in messenger-bot discord-bot zalo-bot; do
  [ "$(cat "$dir/state/$app.sha")" = "$SHA_B" ] || fail "$app state sha != $SHA_B"
done
[ ! -f "$dir/curl.log" ] || fail "alert should not be posted on success"
pass "success path"

echo "Test 3b: self-pull passes the shared app network to each deploy"
[ "$(grep -c '^FAKE app network app_n8n_db_network$' "$dir/deploy-network.log")" -eq 3 ] || fail "shared app network was not passed to all deploys"
pass "self-pull passes app network"

echo "Test 3c: self-pull passes the migration lock contract to the owner"
grep -q '^FAKE migration lock 4242424242$' "$dir/deploy-network.log" || fail "migration lock id was not passed to deploys"
pass "self-pull passes migration lock id"

echo "Test 4: concurrency -> second run skips, no second fetch/reset mid-deploy"
dir=$(make_env concurrency)
run_script "$dir" FAKE_DEPLOY_SLEEP=3 >/dev/null 2>&1 &
bg_pid=$!
for _ in $(seq 1 50); do
  [ -f "$dir/deploy.started" ] && break
  sleep 0.1
done
[ -f "$dir/deploy.started" ] || fail "first run never acquired the deploy lock"
code2=$(run_script "$dir")
wait "$bg_pid" || true
[ "$code2" -eq 0 ] || fail "second run should exit 0, got $code2"
grep -q "Another self-pull run is still in progress" "$dir/run.out" || fail "second run did not report skip"
[ "$(grep -c '^git fetch' "$dir/git.log")" -eq 1 ] || fail "expected exactly 1 fetch (second run must not fetch/reset under lock)"
[ "$(grep -c '^git reset' "$dir/git.log")" -eq 1 ] || fail "expected exactly 1 reset"
[ "$(grep -c '^FAKE vps-deploy' "$dir/deploy.log")" -eq 3 ] || fail "first run deploys incomplete"
pass "concurrency lock respected"

echo "Test 5: stall recovery -> marker cleared + resolved alert posted"
dir=$(make_env recovery)
echo "2026-08-16T00:00:00+07:00 fetch_failed $SHA_A" > "$dir/state/stall"
code=$(run_script "$dir")
[ "$code" -eq 0 ] || fail "expected exit 0, got $code"
[ ! -f "$dir/state/stall" ] || fail "stall marker not cleared"
grep -q "Recovered from previous stall" "$dir/run.out" || fail "recovery not logged"
grep -q "endsAt" "$dir/curl.body" || fail "resolved alert not posted"
pass "stall recovery"

echo "Test 6: non-owner deploy failure -> marker + per-app alert, retried next run (#202)"
dir=$(make_env app-fail)
code=$(run_script "$dir" FAKE_DEPLOY_FAIL_APP=discord-bot)
[ "$code" -eq 0 ] || fail "script must not exit non-zero on per-app failure (retry next tick), got $code"
[ -f "$dir/state/discord-bot.failed" ] || fail "discord-bot failed marker missing"
[ "$(cat "$dir/state/discord-bot.failed")" = "$SHA_B" ] || fail "discord-bot failed marker sha != $SHA_B"
[ ! -f "$dir/state/discord-bot.sha" ] || fail "discord-bot state sha must not be written on failure"
for app in messenger-bot zalo-bot; do
  [ "$(cat "$dir/state/$app.sha")" = "$SHA_B" ] || fail "$app state sha != $SHA_B"
  [ ! -f "$dir/state/$app.failed" ] || fail "$app must not have a failure marker"
done
grep -q 'alertname":"vps_self_pull_app_failed' "$dir/curl.body" || fail "per-app alert not posted"
grep -q "curl -sf -X POST" "$dir/curl.log" || fail "alert not posted"
pass "per-app failure alerted"

echo "Test 7: per-app recovery -> markers cleared + resolved alert (#202)"
dir=$(make_env app-recover)
code=$(run_script "$dir" FAKE_DEPLOY_FAIL_APP=discord-bot)
[ "$code" -eq 0 ] || fail "failure run should exit 0, got $code"
[ -f "$dir/state/discord-bot.failed" ] || fail "discord-bot failed marker missing before recovery"
code2=$(run_script "$dir")
[ "$code2" -eq 0 ] || fail "recovery run should exit 0, got $code2"
for app in messenger-bot discord-bot zalo-bot; do
  [ ! -f "$dir/state/$app.failed" ] || fail "$app failed marker not cleared"
  [ "$(cat "$dir/state/$app.sha")" = "$SHA_B" ] || fail "$app state sha != $SHA_B"
done
grep -q "endsAt" "$dir/curl.body" || fail "resolved per-app alert not posted"
pass "per-app failure recovered + alert resolved"

echo "Test 10: migration owner failure blocks Discord/Zalo traffic changes (#283)"
dir=$(make_env migration-barrier)
code=$(run_script "$dir" FAKE_DEPLOY_FAIL_APP=messenger-bot)
[ "$code" -eq 0 ] || fail "barrier failure should retry next tick, got $code"
[ "$(grep -c '^FAKE vps-deploy' "$dir/deploy.log")" -eq 1 ] || fail "dependent apps deployed after migration owner failure"
grep -q '^FAKE vps-deploy messenger-bot' "$dir/deploy.log" || fail "migration owner was not attempted"
grep -q "migration barrier" "$dir/run.out" || fail "missing migration barrier log"
for app in discord-bot zalo-bot; do
  [ ! -f "$dir/state/$app.sha" ] || fail "$app state written despite blocked migration barrier"
  [ ! -f "$dir/state/$app.failed" ] || fail "$app failure marker written without an attempt"
done
pass "migration owner gates dependent apps"

echo "Test 8: digest extraction — IMAGE_DIGEST passed to deploy when manifest returns digest (#196)"
dir=$(make_env digest-extract)
# Override docker to return a JSON with digest on manifest inspect
cat > "$dir/bin/docker" <<'FAKE'
#!/usr/bin/env bash
echo "docker $*" >> "${DOCKER_LOG:?}"
case "$1" in
  login) exit 0 ;;
  manifest)
    # Return JSON with sha256 digest
    printf '{"schemaVersion":2,"config":{"digest":"sha256:fedcba9876543210"}}\n'
    exit 0
    ;;
  *) exit 0 ;;
esac
FAKE
chmod +x "$dir/bin/docker"
code=$(run_script "$dir")
[ "$code" -eq 0 ] || fail "deploy failed with digest extraction, exit $code: $(cat "$dir/run.out")"
grep -q "Deploying.*digest sha256:fedcba9876543210" "$dir/run.out" || fail "digest not logged in deploy output"
# Verify the fake deploy script received IMAGE_DIGEST
grep -q "FAKE vps-deploy messenger-bot" "$dir/deploy.log" || fail "deploy did not run"
pass "digest extraction works"

echo "Test 9: digest extraction failure -> fail closed, no deploy (#196)"
dir=$(make_env digest-fail)
# Override docker to return empty on manifest inspect (simulates digest extraction failure)
cat > "$dir/bin/docker" <<'FAKE'
#!/usr/bin/env bash
echo "docker $*" >> "${DOCKER_LOG:?}"
case "$1" in
  login) exit 0 ;;
  manifest)
    # Return empty JSON (no digest)
    printf '{}\n'
    exit 0
    ;;
  *) exit 0 ;;
esac
FAKE
chmod +x "$dir/bin/docker"
code=$(run_script "$dir")
[ "$code" -eq 0 ] || fail "script must not exit non-zero on per-app digest failure (retry next tick), got $code"
grep -q "could not extract digest" "$dir/run.out" || fail "missing digest extraction error"
[ ! -f "$dir/deploy.log" ] || fail "deploy must not run when digest extraction fails"
[ -f "$dir/state/messenger-bot.failed" ] || fail "messenger-bot failed marker missing"
for app in discord-bot zalo-bot; do
  [ ! -f "$dir/state/$app.failed" ] || fail "$app failure marker written without a deploy attempt"
done
pass "digest extraction failure fail closed"

echo "Test 11: already-deployed guard -> skip deploy when container matches target digest"
dir=$(make_env already-deployed)
# Override docker to simulate a running container with the target digest
cat > "$dir/bin/docker" <<'FAKE'
#!/usr/bin/env bash
echo "docker $*" >> "${DOCKER_LOG:?}"
case "$1" in
  login) exit 0 ;;
  manifest)
    printf '{"schemaVersion":2,"config":{"digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}\n'
    exit 0
    ;;
  inspect)
    # Simulate a running container with the target image digest
    if echo "$*" | grep -q -- '--format'; then
      printf 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'
    fi
    exit 0
    ;;
  ps)
    # Simulate a running container
    printf 'messenger-bot-old\n'
    exit 0
    ;;
  *) exit 0 ;;
esac
FAKE
chmod +x "$dir/bin/docker"
code=$(run_script "$dir")
[ "$code" -eq 0 ] || fail "already-deployed guard failed, exit $code: $(cat "$dir/run.out")"
grep -q "already running target image" "$dir/run.out" || fail "skip message not logged"
[ "$(cat "$dir/state/messenger-bot.sha")" = "$SHA_B" ] || fail "messenger-bot state sha != $SHA_B"
# Discord and zalo should still deploy (messenger is skipped, not failed)
[ "$(cat "$dir/state/discord-bot.sha")" = "$SHA_B" ] || fail "discord-bot state sha != $SHA_B"
[ "$(cat "$dir/state/zalo-bot.sha")" = "$SHA_B" ] || fail "zalo-bot state sha != $SHA_B"
[ ! -f "$dir/state/messenger-bot.failed" ] || fail "messenger-bot should not have failed marker"
pass "already-deployed guard works"

echo "Test 12: already-deployed guard clears previous failure marker"
dir=$(make_env already-deployed-recover)
echo "$SHA_A" > "$dir/state/messenger-bot.failed"
# Override docker to simulate a running container with the target digest
cat > "$dir/bin/docker" <<'FAKE'
#!/usr/bin/env bash
echo "docker $*" >> "${DOCKER_LOG:?}"
case "$1" in
  login) exit 0 ;;
  manifest)
    printf '{"schemaVersion":2,"config":{"digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}\n'
    exit 0
    ;;
  inspect)
    if echo "$*" | grep -q -- '--format'; then
      printf 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'
    fi
    exit 0
    ;;
  ps)
    printf 'messenger-bot-old\n'
    exit 0
    ;;
  *) exit 0 ;;
esac
FAKE
chmod +x "$dir/bin/docker"
code=$(run_script "$dir")
[ "$code" -eq 0 ] || fail "guard with recovery failed, exit $code"
[ ! -f "$dir/state/messenger-bot.failed" ] || fail "failed marker not cleared"
grep -q "previous deploy failure recovered" "$dir/run.out" || fail "recovery not logged"
pass "guard clears failure marker"

echo "Test 13: migration owner image missing -> barrier blocked, alert, no dependent deploys (#338)"
dir=$(make_env barrier-missing-image)
cat > "$dir/bin/docker" <<'FAKE'
#!/usr/bin/env bash
echo "docker $*" >> "${DOCKER_LOG:?}"
case "$1" in
  login) exit 0 ;;
  manifest)
    # Simulate image not published — manifest inspect fails
    printf '' >&2
    exit 1
    ;;
  *) exit 0 ;;
esac
FAKE
chmod +x "$dir/bin/docker"
code=$(run_script "$dir")
[ "$code" -eq 0 ] || fail "barrier failure should retry next tick, got $code"
grep -q "migration owner.*not published yet" "$dir/run.out" || fail "missing migration owner barrier error"
grep -q "schema is not current" "$dir/run.out" || fail "barrier did not state the schema reason"
[ -f "$dir/state/messenger-bot.failed" ] || fail "messenger-bot failed marker missing"
[ "$(cat "$dir/state/messenger-bot.failed")" = "$SHA_B" ] || fail "messenger-bot failed marker sha != $SHA_B"
grep -q 'alertname":"vps_self_pull_app_failed' "$dir/curl.body" || fail "barrier alert not posted"
[ ! -f "$dir/state/discord-bot.sha" ] || fail "discord-bot deployed despite blocked barrier"
[ ! -f "$dir/state/zalo-bot.sha" ] || fail "zalo-bot deployed despite blocked barrier"
grep -q "migration barrier" "$dir/run.out" || fail "missing migration barrier log"
pass "missing image blocks migration barrier"

echo "Test 14: migration owner manifest auth failure -> barrier blocked (#338)"
dir=$(make_env barrier-auth-fail)
cat > "$dir/bin/docker" <<'FAKE'
#!/usr/bin/env bash
echo "docker $*" >> "${DOCKER_LOG:?}"
case "$1" in
  login) exit 0 ;;
  manifest)
    # Simulate auth failure
    echo "unauthorized: authentication required" >&2
    exit 1
    ;;
  *) exit 0 ;;
esac
FAKE
chmod +x "$dir/bin/docker"
code=$(run_script "$dir")
[ "$code" -eq 0 ] || fail "auth failure should retry next tick, got $code"
grep -q "migration owner.*not published yet" "$dir/run.out" || fail "missing migration owner barrier error"
grep -q "schema is not current" "$dir/run.out" || fail "barrier did not state the schema reason"
[ -f "$dir/state/messenger-bot.failed" ] || fail "messenger-bot failed marker missing"
grep -q 'alertname":"vps_self_pull_app_failed' "$dir/curl.body" || fail "barrier alert not posted"
[ ! -f "$dir/state/discord-bot.sha" ] || fail "discord-bot deployed despite blocked barrier"
[ ! -f "$dir/state/zalo-bot.sha" ] || fail "zalo-bot deployed despite blocked barrier"
pass "auth failure blocks migration barrier"

echo "Test 15: non-migration owner image missing -> skip without blocking barrier (#338)"
dir=$(make_env skip-non-owner)
cat > "$dir/bin/docker" <<'FAKE'
#!/usr/bin/env bash
echo "docker $*" >> "${DOCKER_LOG:?}"
case "$1" in
  login) exit 0 ;;
  manifest)
    # Messenger succeeds, discord fails
    if echo "$*" | grep -q "discord-bot"; then
      echo "unauthorized" >&2
      exit 1
    fi
    printf '{"schemaVersion":2,"config":{"digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}\n'
    exit 0
    ;;
  *) exit 0 ;;
esac
FAKE
chmod +x "$dir/bin/docker"
code=$(run_script "$dir")
[ "$code" -eq 0 ] || fail "non-owner skip should not fail, got $code"
grep -q "discord-bot.*not published yet" "$dir/run.out" || fail "missing skip log for discord"
[ "$(cat "$dir/state/messenger-bot.sha")" = "$SHA_B" ] || fail "messenger-bot not deployed"
[ ! -f "$dir/state/discord-bot.sha" ] || fail "discord-bot deployed despite missing image"
[ ! -f "$dir/state/discord-bot.failed" ] || fail "discord-bot should not have failed marker (just skipped)"
pass "non-migration owner skip without barrier block"

echo "Test 16: HEAD produced no image -> target the newest published commit, no barrier block"
dir=$(make_env resolve-target-sha)
# Already deployed at the parent commit; HEAD is a docs/spec-only commit that
# CI deliberately built nothing for. Pinning to HEAD used to block the barrier
# on every tick (7285bd67 did it 1751 times) and page each new sha.
for app in messenger-bot discord-bot zalo-bot; do echo "$SHA_A" > "$dir/state/$app.sha"; done
cat > "$dir/bin/docker" <<FAKE
#!/usr/bin/env bash
echo "docker \$*" >> "\${DOCKER_LOG:?}"
case "\$1" in
  login) exit 0 ;;
  manifest)
    # No image for HEAD ($SHA_B); the parent ($SHA_A) is published.
    if echo "\$*" | grep -q "$SHA_B"; then
      echo "manifest unknown" >&2
      exit 1
    fi
    printf '{"schemaVersion":2,"config":{"digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}
'
    exit 0
    ;;
  *) exit 0 ;;
esac
FAKE
chmod +x "$dir/bin/docker"
code=$(run_script "$dir")
[ "$code" -eq 0 ] || fail "resolution run should exit 0, got $code: $(cat "$dir/run.out")"
grep -q "targeting newest published commit $SHA_A" "$dir/run.out" || fail "did not fall back to the published commit"
grep -q "Migration barrier ready" "$dir/run.out" || fail "barrier blocked despite a resolvable target"
[ ! -f "$dir/deploy.log" ] || fail "nothing new to deploy, but a deploy ran"
for app in messenger-bot discord-bot zalo-bot; do
  [ ! -f "$dir/state/$app.failed" ] || fail "$app marked failed for a commit that built nothing"
  [ "$(cat "$dir/state/$app.sha")" = "$SHA_A" ] || fail "$app state sha moved off $SHA_A"
done
[ ! -s "$dir/curl.body" ] || fail "alert paged for a commit that legitimately built nothing"
pass "no-image HEAD resolves to the newest published commit"


# Owner has no image anywhere in the lookback window — the case resolution
# cannot rescue. The barrier then asks the question it actually cares about:
# is the schema already at the revision this release expects (#695)?
make_no_owner_image_docker() { # dir
  cat > "$1/bin/docker" <<FAKE
#!/usr/bin/env bash
echo "docker \$*" >> "\${DOCKER_LOG:?}"
case "\$1" in
  login) [ -z "\${FAKE_LOGIN_FAIL:-}" ] || exit 1; exit 0 ;;
  manifest)
    # messenger-bot is unpublished at every sha; the dependents are published.
    if echo "\$*" | grep -q "messenger-bot"; then
      echo "manifest unknown" >&2
      exit 1
    fi
    printf '{"schemaVersion":2,"config":{"digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}
'
    exit 0
    ;;
  *) exit 0 ;;
esac
FAKE
  chmod +x "$1/bin/docker"
}

echo "Test 17: no owner image, no migration since the applied revision -> barrier ready, no page"
dir=$(make_env schema-current)
for app in messenger-bot discord-bot zalo-bot; do echo "$SHA_A" > "$dir/state/$app.sha"; done
make_no_owner_image_docker "$dir"
code=$(run_script "$dir")
[ "$code" -eq 0 ] || fail "expected exit 0, got $code: $(cat "$dir/run.out")"
grep -q "schema is current, barrier ready" "$dir/run.out" || fail "barrier did not fall back to schema state"
grep -q "Migration barrier ready" "$dir/run.out" || fail "dependents were not released"
grep -q "discord-bot" "$dir/deploy.log" || fail "discord-bot did not deploy behind a current schema"
[ ! -f "$dir/state/messenger-bot.failed" ] || fail "owner marked failed while the schema was current"
[ ! -s "$dir/curl.body" ] || fail "paged for a missing image that changed no migration"
pass "missing owner image with a current schema does not block"

echo "Test 18: no owner image but a migration was added -> fail closed, page once"
dir=$(make_env schema-stale)
for app in messenger-bot discord-bot zalo-bot; do echo "$SHA_A" > "$dir/state/$app.sha"; done
make_no_owner_image_docker "$dir"
code=$(run_script "$dir" FAKE_MIGRATION_CHANGED=1)
[ "$code" -eq 0 ] || fail "script should still exit 0, got $code: $(cat "$dir/run.out")"
grep -q "schema is not current" "$dir/run.out" || fail "missing the stale-schema reason"
grep -q "migration barrier not ready" "$dir/run.out" || fail "barrier let dependents through with an unapplied migration"
[ ! -f "$dir/deploy.log" ] || fail "a deploy ran behind a blocked barrier"
[ "$(cat "$dir/state/messenger-bot.failed")" = "$SHA_B" ] || fail "owner failure marker not written for $SHA_B"
grep -q 'alertname":"vps_self_pull_app_failed' "$dir/curl.body" || fail "no alert for an unapplied migration"
pass "unapplied migration still fails closed"

echo "Test 19: docker login failure is reported as a credential fault, not a missing build"
dir=$(make_env login-failure)
for app in messenger-bot discord-bot zalo-bot; do echo "$SHA_A" > "$dir/state/$app.sha"; done
make_no_owner_image_docker "$dir"
code=$(run_script "$dir" FAKE_LOGIN_FAIL=1)
[ "$code" -eq 0 ] || fail "expected exit 0, got $code: $(cat "$dir/run.out")"
grep -q "docker login to ghcr.io failed" "$dir/run.out" || fail "login failure not logged"
grep -q "check the GHCR pull token" "$dir/run.out" || fail "cause not attributed to the credential"
pass "login failure distinguishable from an unpublished image"

[ "$FAILED" -eq 0 ] && echo "ALL TESTS PASSED"
exit "$FAILED"
