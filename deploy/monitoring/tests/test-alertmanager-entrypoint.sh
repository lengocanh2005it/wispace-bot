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

echo "Test 1: missing TELEGRAM_BOT_TOKEN → exit 1"
mkdir -p "$TEST_DIR/t1/etc/alertmanager"
cp /dev/null "$TEST_DIR/t1/etc/alertmanager/alertmanager.tmpl"
TELEGRAM_CHAT_ID="123" sh "$SCRIPT" 2>"$TEST_DIR/t1.err" && code=0 || code=$?
[ "$code" -ne 0 ] || fail "expected non-zero exit"
grep -q "FATAL.*TELEGRAM_BOT_TOKEN" "$TEST_DIR/t1.err" 2>/dev/null || fail "missing FATAL log"
pass "missing token fails closed"

echo "Test 2: missing TELEGRAM_CHAT_ID → exit 1"
mkdir -p "$TEST_DIR/t2/etc/alertmanager"
cp /dev/null "$TEST_DIR/t2/etc/alertmanager/alertmanager.tmpl"
TELEGRAM_BOT_TOKEN="123:abc" sh "$SCRIPT" 2>"$TEST_DIR/t2.err" && code=0 || code=$?
[ "$code" -ne 0 ] || fail "expected non-zero exit"
grep -q "FATAL.*TELEGRAM_CHAT_ID" "$TEST_DIR/t2.err" 2>/dev/null || fail "missing FATAL log"
pass "missing chat_id fails closed"

echo "Test 3: both missing → exit 1"
mkdir -p "$TEST_DIR/t3/etc/alertmanager"
cp /dev/null "$TEST_DIR/t3/etc/alertmanager/alertmanager.tmpl"
sh "$SCRIPT" 2>"$TEST_DIR/t3.err" && code=0 || code=$?
[ "$code" -ne 0 ] || fail "expected non-zero exit"
grep -q "FATAL" "$TEST_DIR/t3.err" 2>/dev/null || fail "missing FATAL log"
pass "both missing fails closed"

echo "Test 4: invalid TELEGRAM_CHAT_ID → exit 1"
TELEGRAM_BOT_TOKEN="123:abc" TELEGRAM_CHAT_ID="not-an-int" \
  sh "$SCRIPT" 2>"$TEST_DIR/t4.err" && code=0 || code=$?
[ "$code" -ne 0 ] || fail "expected non-zero exit"
grep -q "FATAL.*TELEGRAM_CHAT_ID" "$TEST_DIR/t4.err" 2>/dev/null || fail "missing FATAL log"
pass "invalid chat id fails closed"

echo "Test 5: zero/sentinel/leading-zero/out-of-range TELEGRAM_CHAT_ID values → exit 1"
for invalid_chat_id in 0 -1 00 -0 9223372036854775808 -9223372036854775809; do
  TELEGRAM_BOT_TOKEN="123:abc" TELEGRAM_CHAT_ID="$invalid_chat_id" \
    sh "$SCRIPT" 2>"$TEST_DIR/t5-$invalid_chat_id.err" && code=0 || code=$?
  [ "$code" -ne 0 ] || fail "expected $invalid_chat_id to fail"
done
pass "zero and non-canonical chat ids fail closed"

echo "Test 6: compose has no -1 sentinel default for TELEGRAM_CHAT_ID (#373)"
! grep -q 'TELEGRAM_CHAT_ID:.*--1' "$MON/docker-compose.yml" || fail "sentinel default still present"
grep -q 'TELEGRAM_CHAT_ID: ${TELEGRAM_CHAT_ID:-}' "$MON/docker-compose.yml" || fail "default is not empty (fail-closed)"
pass "no sentinel default; missing means empty means exit 1"

echo "Test 7: successful render places token and chat id (SRC/DST/DRY_RUN)"
TELEGRAM_BOT_TOKEN="110022:AABB-test_token" TELEGRAM_CHAT_ID="123456789" \
  SRC="$MON/alertmanager.tmpl" DST="$TEST_DIR/t5.yml" DRY_RUN=1 \
  sh "$SCRIPT" 2>"$TEST_DIR/t5.err" && code=0 || code=$?
[ "$code" -eq 0 ] || fail "expected exit 0, got $code"
grep -Fq 'bot_token: "110022:AABB-test_token"' "$TEST_DIR/t5.yml" || fail "token not rendered"
grep -Fq 'chat_id: 123456789' "$TEST_DIR/t5.yml" || fail "chat id not rendered"
grep -Fq '${' "$TEST_DIR/t5.yml" && fail "unresolved placeholder remains" || true
! grep -Fq "110022:AABB-test_token" "$TEST_DIR/t5.err" || fail "secret leaked to logs"
! grep -Fq "123456789" "$TEST_DIR/t5.err" || fail "secret leaked to logs"
pass "successful render places token and chat id, no placeholders"

echo "Test 8: special characters render as valid YAML"
TELEGRAM_BOT_TOKEN='110022:AA$pec"'"'"'ial`tok:en-${literal}-__literal__-ß日' TELEGRAM_CHAT_ID="123456789" \
  SRC="$MON/alertmanager.tmpl" DST="$TEST_DIR/t6.yml" DRY_RUN=1 \
  sh "$SCRIPT" 2>"$TEST_DIR/t6.err" && code=0 || code=$?
[ "$code" -eq 0 ] || fail "expected exit 0, got $code"
grep -Fq -- 'bot_token: "110022:AA$pec\"'"'"'ial`tok:en-${literal}-__literal__-ß日"' "$TEST_DIR/t6.yml" || fail "token special chars not YAML-escaped"
! grep -Fq -- '110022:AA$pec'"'"'ial`tok:en_ß日' "$TEST_DIR/t6.err" || fail "secret leaked to logs"
pass "special characters render as valid YAML"

echo "Test 9: missing awk binary → exit 1"
mkdir -p "$TEST_DIR/t7/bin"
SH_BIN="$(command -v sh)"
TELEGRAM_BOT_TOKEN="x" TELEGRAM_CHAT_ID="1" PATH="$TEST_DIR/t7/bin" "$SH_BIN" "$SCRIPT" 2>"$TEST_DIR/t7.err" && code=0 || code=$?
[ "$code" -ne 0 ] || fail "expected non-zero exit"
grep -q "FATAL.*awk" "$TEST_DIR/t7.err" 2>/dev/null || fail "missing FATAL log"
pass "missing awk fails closed"

echo "Test 10: surviving placeholder trips the post-render guard → exit 1"
printf 'note: __LEAKED__\n' > "$TEST_DIR/t8.tmpl"
TELEGRAM_BOT_TOKEN="x" TELEGRAM_CHAT_ID="1" \
  SRC="$TEST_DIR/t8.tmpl" DST="$TEST_DIR/t8.yml" DRY_RUN=1 \
  sh "$SCRIPT" 2>"$TEST_DIR/t8.err" && code=0 || code=$?
[ "$code" -ne 0 ] || fail "expected non-zero exit"
grep -q "FATAL.*unresolved" "$TEST_DIR/t8.err" 2>/dev/null || fail "missing FATAL log"
pass "unresolved placeholder rejected"

echo 'Test 11: unknown $VAR and malformed ${VAR} placeholders fail closed → exit 1'
printf 'note: $UNLISTED_SECRET ${BAD-NAME}\n' > "$TEST_DIR/t9.tmpl"
TELEGRAM_BOT_TOKEN="x" TELEGRAM_CHAT_ID="1" \
  SRC="$TEST_DIR/t9.tmpl" DST="$TEST_DIR/t9.yml" DRY_RUN=1 \
  sh "$SCRIPT" 2>"$TEST_DIR/t9.err" && code=0 || code=$?
[ "$code" -ne 0 ] || fail "expected non-zero exit"
grep -q "FATAL.*unresolved" "$TEST_DIR/t9.err" 2>/dev/null || fail "missing FATAL log"
pass "unknown placeholders rejected"

echo "Test 12: unclosed and malformed markers fail closed"
for marker in '${UNFINISHED' '__FOO-BAR__'; do
  printf 'note: %s\n' "$marker" > "$TEST_DIR/t10.tmpl"
  TELEGRAM_BOT_TOKEN="x" TELEGRAM_CHAT_ID="1" \
    SRC="$TEST_DIR/t10.tmpl" DST="$TEST_DIR/t10.yml" DRY_RUN=1 \
    sh "$SCRIPT" 2>"$TEST_DIR/t10.err" && code=0 || code=$?
  [ "$code" -ne 0 ] || fail "expected malformed marker $marker to fail"
done
pass "malformed markers rejected"

echo "Test 13: control characters in credentials fail closed"
CONTROL_TOKEN="$(printf 'token\twith-tab')"
TELEGRAM_BOT_TOKEN="$CONTROL_TOKEN" TELEGRAM_CHAT_ID="1" \
  SRC="$MON/alertmanager.tmpl" DST="$TEST_DIR/t11.yml" DRY_RUN=1 \
  sh "$SCRIPT" 2>"$TEST_DIR/t11.err" && code=0 || code=$?
[ "$code" -ne 0 ] || fail "expected non-zero exit"
grep -q "FATAL.*control" "$TEST_DIR/t11.err" 2>/dev/null || fail "missing control-character log"
pass "control characters rejected"

echo "Test 14: template comment does not contain Telegram secrets"
! head -n 2 "$MON/alertmanager.tmpl" | grep -Eq '\$\{TELEGRAM_(BOT_TOKEN|CHAT_ID)\}' || fail "secret placeholder remains in comment"
pass "template comment is secret-free"

[ "$FAILED" -eq 0 ] && echo "ALL TESTS PASSED"
exit "$FAILED"
