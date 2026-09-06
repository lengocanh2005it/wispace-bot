#!/bin/sh
# Tests for prometheus-entrypoint.sh credential validation + rendering.
# Needs: sh, grep, awk (for render tests).
# Run: sh deploy/monitoring/tests/test-prometheus-entrypoint.sh
set -e

ROOT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
MON="$ROOT_DIR/deploy/monitoring"
SCRIPT="$MON/prometheus-entrypoint.sh"
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

echo "Test 5: successful render places each key in its job (SRC/DST/DRY_RUN)"
INTERNAL_API_KEY_MESSENGER="m3ss-k3y_01" INTERNAL_API_KEY_DISCORD="d1sc-key_02" INTERNAL_API_KEY_ZALO="zl-key_03" \
  SRC="$MON/prometheus.tmpl" DST="$TEST_DIR/t5.yml" DRY_RUN=1 \
  sh "$SCRIPT" 2>"$TEST_DIR/t5.err" && code=0 || code=$?
[ "$code" -eq 0 ] || fail "expected exit 0, got $code"
grep -Fq "credentials: m3ss-k3y_01" "$TEST_DIR/t5.yml" || fail "messenger key not rendered"
grep -Fq "credentials: d1sc-key_02" "$TEST_DIR/t5.yml" || fail "discord key not rendered"
grep -Fq "credentials: zl-key_03" "$TEST_DIR/t5.yml" || fail "zalo key not rendered"
grep -Fq '${' "$TEST_DIR/t5.yml" && fail "unresolved placeholder remains" || true
! grep -Fq "m3ss-k3y_01" "$TEST_DIR/t5.err" || fail "secret leaked to logs"
! grep -Fq "d1sc-key_02" "$TEST_DIR/t5.err" || fail "secret leaked to logs"
! grep -Fq "zl-key_03" "$TEST_DIR/t5.err" || fail "secret leaked to logs"
pass "successful render places keys, no placeholders"

echo "Test 6: special characters render byte-verbatim"
INTERNAL_API_KEY_MESSENGER='m3ss-k3y_01' \
INTERNAL_API_KEY_DISCORD='dk$pec!al=key:99' \
INTERNAL_API_KEY_ZALO='zl"qu'\''ot\ed`uni-ß日本語' \
  SRC="$MON/prometheus.tmpl" DST="$TEST_DIR/t6.yml" DRY_RUN=1 \
  sh "$SCRIPT" 2>"$TEST_DIR/t6.err" && code=0 || code=$?
[ "$code" -eq 0 ] || fail "expected exit 0, got $code"
grep -Fq -- 'credentials: dk$pec!al=key:99' "$TEST_DIR/t6.yml" || fail "discord special chars mangled"
grep -Fq -- 'credentials: zl"qu'\''ot\ed`uni-ß日本語' "$TEST_DIR/t6.yml" || fail "zalo special chars mangled"
! grep -Fq 'dk$pec!al=key:99' "$TEST_DIR/t6.err" || fail "secret leaked to logs"
! grep -Fq -- 'zl"qu'\''ot\ed`uni-ß日本語' "$TEST_DIR/t6.err" || fail "secret leaked to logs"
pass "special characters render verbatim"

echo "Test 7: missing awk binary → exit 1"
mkdir -p "$TEST_DIR/t7/bin"
SH_BIN="$(command -v sh)"
INTERNAL_API_KEY_MESSENGER="ms" INTERNAL_API_KEY_DISCORD="dk" INTERNAL_API_KEY_ZALO="zl" \
  PATH="$TEST_DIR/t7/bin" "$SH_BIN" "$SCRIPT" 2>"$TEST_DIR/t7.err" && code=0 || code=$?
[ "$code" -ne 0 ] || fail "expected non-zero exit"
grep -q "FATAL.*awk" "$TEST_DIR/t7.err" 2>/dev/null || fail "missing FATAL log"
pass "missing awk fails closed"

echo "Test 8: surviving placeholder trips the post-render guard → exit 1"
printf 'credentials: __LEAKED__\n' > "$TEST_DIR/t8.tmpl"
INTERNAL_API_KEY_MESSENGER="ms" INTERNAL_API_KEY_DISCORD="dk" INTERNAL_API_KEY_ZALO="zl" \
  SRC="$TEST_DIR/t8.tmpl" DST="$TEST_DIR/t8.yml" DRY_RUN=1 \
  sh "$SCRIPT" 2>"$TEST_DIR/t8.err" && code=0 || code=$?
[ "$code" -ne 0 ] || fail "expected non-zero exit"
grep -q "FATAL.*unresolved" "$TEST_DIR/t8.err" 2>/dev/null || fail "missing FATAL log"
pass "unresolved placeholder rejected"

[ "$FAILED" -eq 0 ] && echo "ALL TESTS PASSED"
exit "$FAILED"
