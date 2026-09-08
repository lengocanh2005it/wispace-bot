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
# from the entrypoint unit tests, which need only sh + awk.
if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "a running Docker daemon is required for rendered-config validation" >&2
  exit 1
fi

run_promtool() {
  docker run --rm --user 0:0 --entrypoint promtool \
    -v "$TEST_DIR:/tmp/render:ro" \
    -v "$MON/alert.rules.yml:/etc/prometheus/alert.rules.yml:ro" \
    "$PROM_IMAGE" "$@"
}

run_amtool() {
  docker run --rm --user 0:0 --entrypoint amtool \
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

echo "Test 3: render alertmanager template with dummy creds (#683 full credential set + #515 deadman)"
TELEGRAM_BOT_TOKEN='110022:AA$pec'"'"'ial`tok:en_ß日' TELEGRAM_CHAT_ID="123456789" \
  DISCORD_ALERT_WEBHOOK_CRITICAL_URL='https://discord.com/api/webhooks/123/AA$pec'"'"'ial' \
  DISCORD_ALERT_WEBHOOK_WARNING_URL='https://discord.com/api/webhooks/456/BB$pec'"'"'ial' \
  PUSHOVER_USER_KEY='evalPUSHOVERUSERKEY00' PUSHOVER_API_TOKEN='evalPUSHOVERTOKEN0000' \
  HEALTHCHECKS_PING_URL='https://hc-ping.com/eval-deadman-uuid' \
  SRC="$MON/alertmanager.tmpl" DST="$TEST_DIR/alertmanager.yml" DRY_RUN=1 \
  sh "$MON/alertmanager-entrypoint.sh" || fail "alertmanager render failed"
[ -f "$TEST_DIR/alertmanager.yml" ] || fail "rendered alertmanager.yml missing"
pass "alertmanager template renders"

echo "Test 4: amtool check-config on rendered alertmanager.yml"
run_amtool check-config /tmp/render/alertmanager.yml 2>"$TEST_DIR/amtool.err" \
  || { cat "$TEST_DIR/amtool.err" >&2; fail "amtool check-config failed"; }
pass "rendered alertmanager config is valid"

echo "Test 5: rendered routing branches on severity (#683)"
grep -q 'severity="critical"' "$TEST_DIR/alertmanager.yml" || fail "critical matcher missing"
grep -q 'severity="warning"' "$TEST_DIR/alertmanager.yml" || fail "warning matcher missing"
grep -q 'pushover_configs:' "$TEST_DIR/alertmanager.yml" || fail "pushover receiver missing"
grep -q 'discord_configs:' "$TEST_DIR/alertmanager.yml" || fail "discord receivers missing"
grep -q 'repeat_interval: 30m' "$TEST_DIR/alertmanager.yml" || fail "critical short repeat missing"
pass "severity routing present in rendered config"

echo "Test 6: watchdog intercept route + deadman webhook (#515)"
grep -q 'alertname="Watchdog"' "$TEST_DIR/alertmanager.yml" || fail "watchdog intercept missing"
grep -q 'send_resolved: false' "$TEST_DIR/alertmanager.yml" || fail "deadman must not send resolved"
grep -q 'webhook_configs:' "$TEST_DIR/alertmanager.yml" || fail "deadman webhook receiver missing"
# The intercept must sit BEFORE the severity routes: defense-in-depth against
# someone later giving the Watchdog a critical severity and fanning it out.
awk '/alertname="Watchdog"/ { if (!w) w = NR } /severity="critical"/ { if (!c) c = NR } END { exit !(w && c && w < c) }' \
  "$TEST_DIR/alertmanager.yml" || fail "watchdog route is not before the severity routes"
pass "deadman watchdog routing present and ordered first in rendered config"

[ "$FAILED" -eq 0 ] && echo "ALL TESTS PASSED"
exit "$FAILED"
