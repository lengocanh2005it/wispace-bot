#!/usr/bin/env bash
# Regression tests for SSH deploy payload isolation (#282).
set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/ssh-deploy-vps.sh"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

FAILED=0

fail() { echo "FAIL: $1" >&2; FAILED=1; }
pass() { echo "  ok: $1"; }

make_fake_bin() {
  local dir="$1"
  cat > "$dir/ssh" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
attempt_file="${FAKE_CAPTURE_DIR}/attempt"
attempt=0
[ -f "$attempt_file" ] && attempt=$(cat "$attempt_file")
attempt=$((attempt + 1))
printf '%s\n' "$attempt" > "$attempt_file"
for arg in "$@"; do printf 'ARG=%s\n' "$arg" >> "${FAKE_CAPTURE_DIR}/argv.log"; done
cat > "${FAKE_CAPTURE_DIR}/stdin-${attempt}"
printf 'ssh attempt %s\n' "$attempt" >> "${FAKE_CAPTURE_DIR}/ssh.log"
[ "$attempt" -le "${FAKE_SSH_FAIL_COUNT:-0}" ] && exit 1
exit 0
FAKE
  cat > "$dir/sleep" <<'FAKE'
#!/usr/bin/env bash
printf 'sleep %s\n' "$*" >> "${FAKE_CAPTURE_DIR}/sleep.log"
exit 0
FAKE
  chmod +x "$dir/ssh" "$dir/sleep"
}

run_script() {
  local dir="$1"; shift
  mkdir -p "$dir/home/.ssh" "$dir/capture"
  (
    export HOME="$dir/home" VPS_SSH_PORT=22 VPS_TARGET_DIR=/home/ngoc_anh/messenger-bot
    export SSH_PRIVATE_KEY='private-key' VPS_HOST=vps.example VPS_USER=deploy
    export VPS_KNOWN_HOSTS='vps.example ssh-ed25519 AAAA'
    export IMAGE='ghcr.io/example/bot:tag; echo image-injected'
    export DEPLOY_MODE='new-build' FORCE_RECREATE=true GHCR_PULL_TOKEN='super-secret-token'
    export GHCR_USER='github-user' APP_NAME='messenger-bot' HEALTH_PATH='/health/ready'
    export PORT=5007 RUN_MIGRATIONS=false MIGRATION_CMD='echo migration; touch injected'
    export NGINX_UPSTREAM_DIR='/home/ngoc_anh/infra/nginx/upstreams'
    export FAKE_CAPTURE_DIR="$dir/capture" PATH="$dir/bin:$PATH"
    bash "$SCRIPT" "$@"
  ) > "$dir/output.log" 2>&1
}

dir="$TEST_ROOT/single"
mkdir -p "$dir/bin"
make_fake_bin "$dir/bin"
echo "Test 1: deploy token is sent only through stdin payload"
run_script "$dir" /home/ngoc_anh/messenger-bot/vps-deploy.sh

! grep -F 'super-secret-token' "$dir/capture/argv.log" "$dir/capture/ssh.log" "$dir/output.log" 2>/dev/null \
  || fail "deploy token leaked into argv or log"
grep -Fq 'super-secret-token' "$dir/capture/stdin-1" || fail "deploy token missing from stdin payload"
grep -Fq 'exec bash "$1" </dev/null' "$dir/capture/argv.log" || fail "remote wrapper does not detach deploy stdin"
[ "$(find "$dir/capture" -name 'stdin-*' | wc -l)" -eq 1 ] || fail "unexpected SSH attempt count"
pass "payload is isolated from SSH command and logs"

echo "Test 2: shell metacharacters in deploy values do not execute locally"
marker="$dir/injected"
mkdir -p "$dir/metachar/bin"
make_fake_bin "$dir/metachar/bin"
(
  export INJECT_MARKER="$marker"
  run_script "$dir/metachar" /home/ngoc_anh/messenger-bot/vps-deploy.sh
) || fail "metacharacter payload failed"
[ ! -e "$marker" ] || fail "shell metacharacter was executed"
pass "deploy values remain data"

echo "Test 3: every retry sends a fresh payload"
dir="$TEST_ROOT/retry"
mkdir -p "$dir/bin"
make_fake_bin "$dir/bin"
(
  export FAKE_SSH_FAIL_COUNT=3
  run_script "$dir" /home/ngoc_anh/messenger-bot/vps-deploy.sh
)
[ "$(cat "$dir/capture/attempt")" -eq 4 ] || fail "expected 4 SSH attempts"
for attempt in 1 2 3 4; do
  grep -Fq 'super-secret-token' "$dir/capture/stdin-${attempt}" \
    || fail "retry $attempt did not receive a fresh payload"
done
[ "$(wc -l < "$dir/capture/sleep.log")" -eq 3 ] || fail "retry backoff did not run three times"
pass "each retry regenerates and resends payload"

echo "Test 4: unsafe remote script paths fail before SSH"
dir="$TEST_ROOT/validation"
mkdir -p "$dir/bin"
make_fake_bin "$dir/bin"
unsafe="/home/ngoc_anh/messenger-bot/\$(touch "$dir/injected")"
if run_script "$dir" "$unsafe"; then
  fail "unsafe remote script path was accepted"
fi
[ ! -e "$dir/injected" ] || fail "unsafe path command substitution executed"
[ ! -f "$dir/capture/attempt" ] || fail "SSH ran for unsafe remote script path"
pass "remote script path is validated"

[ "$FAILED" -eq 0 ] && echo "ALL TESTS PASSED"
exit "$FAILED"
