#!/bin/sh
# Tests for alertmanager-entrypoint.sh credential validation + rendering.
# Needs: sh, grep, awk (for render tests).
# Run: sh deploy/monitoring/tests/test-alertmanager-entrypoint.sh
set -e

ROOT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
MON="$ROOT_DIR/deploy/monitoring"
SCRIPT="$MON/alertmanager-entrypoint.sh"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

FAILED=0
fail() { echo "FAIL: $1" >&2; FAILED=1; }
pass() { echo "  ok: $1"; }

# --- #683: severity routing adds four more fail-closed credentials ---

FULL_CREDS="TELEGRAM_BOT_TOKEN=110022:AA-test TELEGRAM_CHAT_ID=123456789 DISCORD_ALERT_WEBHOOK_CRITICAL_URL=https://discord.com/api/webhooks/1/AAAA DISCORD_ALERT_WEBHOOK_WARNING_URL=https://discord.com/api/webhooks/2/BBBB PUSHOVER_USER_KEY=uQ9wCkrJMBvL1YyR3LSSDpAz123456 PUSHOVER_API_TOKEN=aQ9wCkrJMBvL1YyR3LSSDpAz123456"

run_render() { # dst [VAR=value overrides...]
  local dst="$1"; shift
  # shellcheck disable=SC2086
  env $FULL_CREDS SRC="$MON/alertmanager.tmpl" DST="$dst" DRY_RUN=1 "$@" \
    sh "$SCRIPT" 2>"$dst.err"
}

echo "Test 1: missing TELEGRAM_BOT_TOKEN → exit 1"
mkdir -p "$TEST_DIR/t1/etc/alertmanager"
cp /dev/null "$TEST_DIR/t1/etc/alertmanager/alertmanager.tmpl"
# shellcheck disable=SC2086
env $FULL_CREDS TELEGRAM_BOT_TOKEN= sh "$SCRIPT" 2>"$TEST_DIR/t1.err" && code=0 || code=$?
[ "$code" -ne 0 ] || fail "expected non-zero exit"
grep -q "FATAL.*TELEGRAM_BOT_TOKEN" "$TEST_DIR/t1.err" 2>/dev/null || fail "missing FATAL log"
pass "missing token fails closed"

echo "Test 2: missing TELEGRAM_CHAT_ID → exit 1"
mkdir -p "$TEST_DIR/t2/etc/alertmanager"
cp /dev/null "$TEST_DIR/t2/etc/alertmanager/alertmanager.tmpl"
# shellcheck disable=SC2086
env $FULL_CREDS TELEGRAM_CHAT_ID= sh "$SCRIPT" 2>"$TEST_DIR/t2.err" && code=0 || code=$?
[ "$code" -ne 0 ] || fail "expected non-zero exit"
grep -q "FATAL.*TELEGRAM_CHAT_ID" "$TEST_DIR/t2.err" 2>/dev/null || fail "missing FATAL log"
pass "missing chat_id fails closed"

echo "Test 3: both missing → exit 1"
mkdir -p "$TEST_DIR/t3/etc/alertmanager"
cp /dev/null "$TEST_DIR/t3/etc/alertmanager/alertmanager.tmpl"
# shellcheck disable=SC2086
env $FULL_CREDS TELEGRAM_BOT_TOKEN= TELEGRAM_CHAT_ID= sh "$SCRIPT" 2>"$TEST_DIR/t3.err" && code=0 || code=$?
[ "$code" -ne 0 ] || fail "expected non-zero exit"
grep -q "FATAL" "$TEST_DIR/t3.err" 2>/dev/null || fail "missing FATAL log"
pass "both missing fails closed"

echo "Test 4: invalid TELEGRAM_CHAT_ID → exit 1"
# shellcheck disable=SC2086
env $FULL_CREDS TELEGRAM_CHAT_ID="not-an-int" sh "$SCRIPT" 2>"$TEST_DIR/t4.err" && code=0 || code=$?
[ "$code" -ne 0 ] || fail "expected non-zero exit"
grep -q "FATAL.*TELEGRAM_CHAT_ID" "$TEST_DIR/t4.err" 2>/dev/null || fail "missing FATAL log"
pass "invalid chat id fails closed"

echo "Test 5: zero/sentinel/leading-zero/out-of-range TELEGRAM_CHAT_ID values → exit 1"
for invalid_chat_id in 0 -1 00 -0 9223372036854775808 -9223372036854775809; do
  # shellcheck disable=SC2086
  env $FULL_CREDS TELEGRAM_CHAT_ID="$invalid_chat_id" \
    sh "$SCRIPT" 2>"$TEST_DIR/t5-$invalid_chat_id.err" && code=0 || code=$?
  [ "$code" -ne 0 ] || fail "expected $invalid_chat_id to fail"
  grep -q "FATAL.*TELEGRAM_CHAT_ID" "$TEST_DIR/t5-$invalid_chat_id.err" 2>/dev/null || fail "missing FATAL log for $invalid_chat_id"
done
pass "zero and non-canonical chat ids fail closed"

echo "Test 6: compose has no -1 sentinel default for TELEGRAM_CHAT_ID (#373)"
! grep -q 'TELEGRAM_CHAT_ID:.*--1' "$MON/docker-compose.yml" || fail "sentinel default still present"
grep -q 'TELEGRAM_CHAT_ID: ${TELEGRAM_CHAT_ID:-}' "$MON/docker-compose.yml" || fail "default is not empty (fail-closed)"
pass "no sentinel default; missing means empty means exit 1"

echo "Test 7: successful render places token and chat id (SRC/DST/DRY_RUN)"
run_render "$TEST_DIR/t5.yml" && code=0 || code=$?
[ "$code" -eq 0 ] || { cat "$TEST_DIR/t5.yml.err" >&2; fail "expected exit 0, got $code"; }
grep -Fq 'bot_token: "110022:AA-test"' "$TEST_DIR/t5.yml" || fail "token not rendered"
grep -Fq 'chat_id: 123456789' "$TEST_DIR/t5.yml" || fail "chat id not rendered"
! grep -Fq '${' "$TEST_DIR/t5.yml" || fail "unresolved placeholder remains"
! grep -Fq "110022:AABB-test_token" "$TEST_DIR/t5.yml.err" || fail "secret leaked to logs"
! grep -Fq "123456789" "$TEST_DIR/t5.yml.err" || fail "secret leaked to logs"
pass "successful render places token and chat id, no placeholders"

echo "Test 8: special characters render as valid YAML"
run_render "$TEST_DIR/t6.yml" \
  TELEGRAM_BOT_TOKEN='110022:AA$pec"'"'"'ial`tok:en-${literal}-__literal__-ß日' \
  && code=0 || code=$?
[ "$code" -eq 0 ] || { cat "$TEST_DIR/t6.yml.err" >&2; fail "expected exit 0, got $code"; }
grep -Fq -- 'bot_token: "110022:AA$pec\"'"'"'ial`tok:en-${literal}-__literal__-ß日"' "$TEST_DIR/t6.yml" || fail "token special chars not YAML-escaped"
! grep -Fq -- '110022:AA$pec'"'"'ial`tok:en_ß日' "$TEST_DIR/t6.yml.err" || fail "secret leaked to logs"
pass "special characters render as valid YAML"

echo "Test 9: missing awk binary → exit 1"
mkdir -p "$TEST_DIR/t7/bin"
SH_BIN="$(command -v sh)"
# shellcheck disable=SC2086
env $FULL_CREDS PATH="$TEST_DIR/t7/bin" "$SH_BIN" "$SCRIPT" 2>"$TEST_DIR/t7.err" && code=0 || code=$?
[ "$code" -ne 0 ] || fail "expected non-zero exit"
grep -q "FATAL.*awk" "$TEST_DIR/t7.err" 2>/dev/null || fail "missing FATAL log"
pass "missing awk fails closed"

echo "Test 10: surviving placeholder trips the post-render guard → exit 1"
printf 'note: __LEAKED__\n' > "$TEST_DIR/t8.tmpl"
run_render "$TEST_DIR/t8.yml" SRC="$TEST_DIR/t8.tmpl" && code=0 || code=$?
[ "$code" -ne 0 ] || fail "expected non-zero exit"
grep -q "FATAL.*unresolved" "$TEST_DIR/t8.yml.err" 2>/dev/null || fail "missing FATAL log"
pass "unresolved placeholder rejected"

echo 'Test 11: unknown $VAR and malformed ${VAR} placeholders fail closed → exit 1'
printf 'note: $UNLISTED_SECRET ${BAD-NAME}\n' > "$TEST_DIR/t9.tmpl"
run_render "$TEST_DIR/t9.yml" SRC="$TEST_DIR/t9.tmpl" && code=0 || code=$?
[ "$code" -ne 0 ] || fail "expected non-zero exit"
grep -q "FATAL.*unresolved" "$TEST_DIR/t9.yml.err" 2>/dev/null || fail "missing FATAL log"
pass "unknown placeholders rejected"

echo "Test 12: unclosed and malformed markers fail closed"
for marker in '${UNFINISHED' '__FOO-BAR__'; do
  printf 'note: %s\n' "$marker" > "$TEST_DIR/t10.tmpl"
  run_render "$TEST_DIR/t10.yml" SRC="$TEST_DIR/t10.tmpl" \
    && code=0 || code=$?
  [ "$code" -ne 0 ] || fail "expected malformed marker $marker to fail"
done
pass "malformed markers rejected"

echo "Test 13: control characters in credentials fail closed"
CONTROL_TOKEN="$(printf 'token\twith-tab')"
run_render "$TEST_DIR/t11.yml" TELEGRAM_BOT_TOKEN="$CONTROL_TOKEN" \
  && code=0 || code=$?
[ "$code" -ne 0 ] || fail "expected non-zero exit"
grep -q "FATAL.*control" "$TEST_DIR/t11.yml.err" 2>/dev/null || fail "missing control-character log"
pass "control characters rejected"

echo "Test 14: template comment does not contain Telegram secrets"
! head -n 2 "$MON/alertmanager.tmpl" | grep -Eq '\$\{TELEGRAM_(BOT_TOKEN|CHAT_ID)\}' || fail "secret placeholder remains in comment"
pass "template comment is secret-free"

# --- #683: severity routing adds four more fail-closed credentials ---

echo "Test 15: empty DISCORD_ALERT_WEBHOOK_CRITICAL_URL → exit 1"
run_render "$TEST_DIR/t15.yml" DISCORD_ALERT_WEBHOOK_CRITICAL_URL= && code=0 || code=$?
[ "$code" -ne 0 ] || fail "expected non-zero exit"
grep -q "FATAL.*DISCORD_ALERT_WEBHOOK_CRITICAL_URL" "$TEST_DIR/t15.yml.err" 2>/dev/null || fail "missing FATAL log"
pass "missing critical webhook fails closed"

echo "Test 16: empty DISCORD_ALERT_WEBHOOK_WARNING_URL → exit 1"
run_render "$TEST_DIR/t16.yml" DISCORD_ALERT_WEBHOOK_WARNING_URL= && code=0 || code=$?
[ "$code" -ne 0 ] || fail "expected non-zero exit"
grep -q "FATAL.*DISCORD_ALERT_WEBHOOK_WARNING_URL" "$TEST_DIR/t16.yml.err" 2>/dev/null || fail "missing FATAL log"
pass "missing warning webhook fails closed"

echo "Test 17: empty PUSHOVER_USER_KEY / PUSHOVER_API_TOKEN → exit 1"
run_render "$TEST_DIR/t17a.yml" PUSHOVER_USER_KEY= && code=0 || code=$?
[ "$code" -ne 0 ] || fail "expected non-zero exit for user key"
grep -q "FATAL.*PUSHOVER_USER_KEY" "$TEST_DIR/t17a.yml.err" 2>/dev/null || fail "missing FATAL log (user key)"
run_render "$TEST_DIR/t17b.yml" PUSHOVER_API_TOKEN= && code=0 || code=$?
[ "$code" -ne 0 ] || fail "expected non-zero exit for api token"
grep -q "FATAL.*PUSHOVER_API_TOKEN" "$TEST_DIR/t17b.yml.err" 2>/dev/null || fail "missing FATAL log (api token)"
pass "missing pushover credentials fail closed"

echo "Test 18: non-discord HTTPS webhook URL → exit 1"
run_render "$TEST_DIR/t18.yml" DISCORD_ALERT_WEBHOOK_CRITICAL_URL='https://evil.example/api/webhooks/1/AAAA' \
  && code=0 || code=$?
[ "$code" -ne 0 ] || fail "expected non-zero exit"
grep -q "FATAL.*DISCORD_ALERT_WEBHOOK_CRITICAL_URL" "$TEST_DIR/t18.yml.err" 2>/dev/null || fail "missing FATAL log"
pass "non-discord webhook host fails closed"

echo "Test 19: http:// webhook URL (no TLS) → exit 1"
run_render "$TEST_DIR/t19.yml" DISCORD_ALERT_WEBHOOK_CRITICAL_URL='http://discord.com/api/webhooks/1/AAAA' \
  && code=0 || code=$?
[ "$code" -ne 0 ] || fail "expected non-zero exit"
pass "plaintext webhook URL fails closed"

echo "Test 20: non-alphanumeric pushover key → exit 1"
run_render "$TEST_DIR/t20.yml" 'PUSHOVER_USER_KEY=has-space-123' && code=0 || code=$?
[ "$code" -ne 0 ] || fail "expected non-zero exit"
grep -q "FATAL.*PUSHOVER_USER_KEY" "$TEST_DIR/t20.yml.err" 2>/dev/null || fail "missing FATAL log"
pass "malformed pushover key fails closed"

echo "Test 21: full-credential render places all secrets and route matchers"
run_render "$TEST_DIR/t21.yml" && code=0 || code=$?
[ "$code" -eq 0 ] || { cat "$TEST_DIR/t21.yml.err" >&2; fail "expected exit 0"; }
grep -Fq 'webhook_url: "https://discord.com/api/webhooks/1/AAAA"' "$TEST_DIR/t21.yml" || fail "critical webhook not rendered"
grep -Fq 'webhook_url: "https://discord.com/api/webhooks/2/BBBB"' "$TEST_DIR/t21.yml" || fail "warning webhook not rendered"
grep -Fq 'user_key: "uQ9wCkrJMBvL1YyR3LSSDpAz123456"' "$TEST_DIR/t21.yml" || fail "pushover user_key not rendered"
grep -Fq 'token: "aQ9wCkrJMBvL1YyR3LSSDpAz123456"' "$TEST_DIR/t21.yml" || fail "pushover token not rendered"
grep -Fq 'severity="critical"' "$TEST_DIR/t21.yml" || fail "critical matcher missing"
! grep -Fq '${' "$TEST_DIR/t21.yml" || fail "unresolved placeholder remains"
for secret in 'AAAA' 'BBBB' 'uQ9wCkrJMBvL1YyR3LSSDpAz123456' 'aQ9wCkrJMBvL1YyR3LSSDpAz123456'; do
  ! grep -Fq "$secret" "$TEST_DIR/t21.yml.err" || fail "secret leaked to logs"
done
pass "all credentials rendered, severity matchers present, no placeholders, no leaks"

echo "Test 22: compose passes the four new credentials with empty defaults"
for var in DISCORD_ALERT_WEBHOOK_CRITICAL_URL DISCORD_ALERT_WEBHOOK_WARNING_URL PUSHOVER_USER_KEY PUSHOVER_API_TOKEN; do
  grep -q "$var: \${$var:-}" "$MON/docker-compose.yml" || fail "compose missing $var passthrough"
done
pass "compose passthrough fail-closed for #683 credentials"

[ "$FAILED" -eq 0 ] && echo "ALL TESTS PASSED"
exit "$FAILED"
