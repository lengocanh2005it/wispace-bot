#!/bin/sh
# Tests for alertmanager-entrypoint.sh credential validation.
# Run: sh deploy/monitoring/tests/test-alertmanager-entrypoint.sh
set -e

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/alertmanager-entrypoint.sh"
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

[ "$FAILED" -eq 0 ] && echo "ALL TESTS PASSED"
exit "$FAILED"
