#!/bin/sh
# Render both monitoring templates with the real entrypoints (dummy creds)
# and validate the output with promtool / amtool inside the pinned runtime
# images. Needs: sh, grep, awk, Docker daemon.
# Run: sh deploy/monitoring/tests/test-rendered-config-validation.sh
set -e

ROOT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
MON="$ROOT_DIR/deploy/monitoring"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

FAILED=0
fail() { echo "FAIL: $1" >&2; FAILED=1; }
pass() { echo "  ok: $1"; }

# Image refs come from the compose file so validation always matches the
# runtime images (fail loud on drift instead of validating the wrong image).
PROM_IMAGE="$(grep -o 'prom/prometheus:[^ "]*' "$MON/docker-compose.yml" | head -n 1 || true)"
[ -n "$PROM_IMAGE" ] || { echo "FAIL: cannot extract prometheus image from compose" >&2; exit 1; }
AM_IMAGE="$(grep -o 'prom/alertmanager:[^ "]*' "$MON/docker-compose.yml" | head -n 1 || true)"
[ -n "$AM_IMAGE" ] || { echo "FAIL: cannot extract alertmanager image from compose" >&2; exit 1; }

# Exact-bytes validation needs the /etc mount layout, so this script requires
# Docker (ubuntu CI has it). Developers without a daemon still get coverage
# from the entrypoint unit tests, which need only sh + envsubst.
if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "a running Docker daemon is required for rendered-config validation" >&2
  exit 1
fi

run_promtool() {
  docker run --rm --entrypoint promtool \
    -v "$TEST_DIR:/tmp/render:ro" \
    -v "$MON/alert.rules.yml:/etc/prometheus/alert.rules.yml:ro" \
    "$PROM_IMAGE" "$@"
}

run_amtool() {
  docker run --rm --entrypoint amtool \
    -v "$TEST_DIR:/tmp/render:ro" \
    "$AM_IMAGE" "$@"
}

echo "Test 1: render prometheus template with adversarial dummy creds"
INTERNAL_API_KEY_MESSENGER="m3ss-k3y_01" INTERNAL_API_KEY_DISCORD='dk$pec!al=key:99' INTERNAL_API_KEY_ZALO='zl"qu'\''ot\ed`uni-ß日本語' \
  SRC="$MON/prometheus.tmpl" DST="$TEST_DIR/prometheus.yml" DRY_RUN=1 \
  sh "$MON/prometheus-entrypoint.sh" || fail "prometheus render failed"
[ -f "$TEST_DIR/prometheus.yml" ] || fail "rendered prometheus.yml missing"
pass "prometheus template renders"

echo "Test 2: promtool check config on rendered prometheus.yml"
run_promtool check config /tmp/render/prometheus.yml 2>"$TEST_DIR/promtool.err" \
  || { cat "$TEST_DIR/promtool.err" >&2; fail "promtool check config failed"; }
pass "rendered prometheus config is valid"

echo "Test 3: render alertmanager template with dummy creds"
TELEGRAM_BOT_TOKEN='110022:AA$pec'"'"'ial`tok:en_ß日' TELEGRAM_CHAT_ID="123456789" \
  SRC="$MON/alertmanager.tmpl" DST="$TEST_DIR/alertmanager.yml" DRY_RUN=1 \
  sh "$MON/alertmanager-entrypoint.sh" || fail "alertmanager render failed"
[ -f "$TEST_DIR/alertmanager.yml" ] || fail "rendered alertmanager.yml missing"
pass "alertmanager template renders"

echo "Test 4: amtool check-config on rendered alertmanager.yml"
run_amtool check-config /tmp/render/alertmanager.yml 2>"$TEST_DIR/amtool.err" \
  || { cat "$TEST_DIR/amtool.err" >&2; fail "amtool check-config failed"; }
pass "rendered alertmanager config is valid"

[ "$FAILED" -eq 0 ] && echo "ALL TESTS PASSED"
exit "$FAILED"
