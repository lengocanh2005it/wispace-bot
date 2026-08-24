#!/bin/sh
# Tests for prometheus-entrypoint.sh credential validation.
# Run: sh deploy/monitoring/tests/test-prometheus-entrypoint.sh
set -e

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/prometheus-entrypoint.sh"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

FAILED=0
fail() { echo "FAIL: $1" >&2; FAILED=1; }
pass() { echo "  ok: $1"; }

echo "Test 1: missing INTERNAL_API_KEY_MESSENGER → exit 1"
mkdir -p "$TEST_DIR/t1/etc/prometheus"
cp /dev/null "$TEST_DIR/t1/etc/prometheus/prometheus.tmpl"
INTERNAL_API_KEY_DISCORD="dk" INTERNAL_API_KEY_ZALO="zl" \
  sh "$SCRIPT" 2>"$TEST_DIR/t1.err" && code=0 || code=$?
[ "$code" -ne 0 ] || fail "expected non-zero exit"
grep -q "FATAL.*INTERNAL_API_KEY_MESSENGER" "$TEST_DIR/t1.err" 2>/dev/null || fail "missing FATAL log"
pass "missing messenger key fails closed"

echo "Test 2: missing INTERNAL_API_KEY_DISCORD → exit 1"
mkdir -p "$TEST_DIR/t2/etc/prometheus"
cp /dev/null "$TEST_DIR/t2/etc/prometheus/prometheus.tmpl"
INTERNAL_API_KEY_MESSENGER="ms" INTERNAL_API_KEY_ZALO="zl" \
  sh "$SCRIPT" 2>"$TEST_DIR/t2.err" && code=0 || code=$?
[ "$code" -ne 0 ] || fail "expected non-zero exit"
grep -q "FATAL.*INTERNAL_API_KEY_DISCORD" "$TEST_DIR/t2.err" 2>/dev/null || fail "missing FATAL log"
pass "missing discord key fails closed"

echo "Test 3: missing INTERNAL_API_KEY_ZALO → exit 1"
mkdir -p "$TEST_DIR/t3/etc/prometheus"
cp /dev/null "$TEST_DIR/t3/etc/prometheus/prometheus.tmpl"
INTERNAL_API_KEY_MESSENGER="ms" INTERNAL_API_KEY_DISCORD="dk" \
  sh "$SCRIPT" 2>"$TEST_DIR/t3.err" && code=0 || code=$?
[ "$code" -ne 0 ] || fail "expected non-zero exit"
grep -q "FATAL.*INTERNAL_API_KEY_ZALO" "$TEST_DIR/t3.err" 2>/dev/null || fail "missing FATAL log"
pass "missing zalo key fails closed"

echo "Test 4: all missing → exit 1"
mkdir -p "$TEST_DIR/t4/etc/prometheus"
cp /dev/null "$TEST_DIR/t4/etc/prometheus/prometheus.tmpl"
sh "$SCRIPT" 2>"$TEST_DIR/t4.err" && code=0 || code=$?
[ "$code" -ne 0 ] || fail "expected non-zero exit"
grep -q "FATAL" "$TEST_DIR/t4.err" 2>/dev/null || fail "missing FATAL log"
pass "all missing fails closed"

[ "$FAILED" -eq 0 ] && echo "ALL TESTS PASSED"
exit "$FAILED"
