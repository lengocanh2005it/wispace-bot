#!/usr/bin/env bash
set -euo pipefail

# VPS-side self-pull deploy: run this via VPS cron, NOT from GitHub Actions.
# The VPS pulls the repo + image itself (outbound to GitHub/GHCR), so it
# never depends on inbound SSH from a GitHub Actions runner IP — the
# provider's edge network intermittently drops those regardless of port
# or retry count (see docs/project-overview.md §12).
#
# One-time VPS setup:
#   git clone https://github.com/lengocanh2005it/wispace-bot.git ~/wispace-bot-src
#   crontab -e
#   */2 * * * * cd ~/wispace-bot-src && source ~/.ghcr-token && \
#     bash .github/scripts/vps-self-pull-deploy.sh >> ~/vps-self-pull-deploy.log 2>&1
#
# The git fetch + reset run INSIDE this script, after the deploy lock is held
# (#172): a concurrent cron tick can never reset the checkout mid-deploy.
# A failed fetch or a stale checkout fails closed with a timestamped ERROR
# and a Telegram alert via the local Alertmanager (default route) instead of
# silently stalling (#144); the next cron tick retries.
#
# .env for each app is NOT touched here — Doppler webhook → each bot's
# /v1/*/ops/doppler-sync endpoint already keeps .env current independently
# (see packages/doppler-sync). This script only rolls the image forward.

REPO_DIR="${REPO_DIR:-$HOME/wispace-bot-src}"
STATE_DIR="${STATE_DIR:-$HOME/.vps-deploy-state}"
LOCK_FILE="${LOCK_FILE:-/tmp/vps-self-pull-deploy.lock}"
REGISTRY="ghcr.io"
REPO_LC="lengocanh2005it/wispace-bot"
NGINX_UPSTREAM_DIR="${NGINX_UPSTREAM_DIR:-/home/ngoc_anh/infra/nginx/upstreams}"
TARGET_BASE_DIR="${TARGET_BASE_DIR:-/home/ngoc_anh}"
ALERTMANAGER_URL="${ALERTMANAGER_URL:-http://127.0.0.1:9093}"
STALL_ALERT="vps_self_pull_stall"
STALL_MARKER="$STATE_DIR/stall"

: "${GHCR_USER:?GHCR_USER is required}"
: "${GHCR_PULL_TOKEN:?GHCR_PULL_TOKEN is required}"

mkdir -p "$STATE_DIR"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "Another self-pull run is still in progress — skipping"
  exit 0
fi

cd "$REPO_DIR"

notify_alert() { # summary description
  local summary="$1" detail="$2"
  curl -sf -X POST "$ALERTMANAGER_URL/api/v2/alerts" \
    -H 'Content-Type: application/json' \
    -d "[{\"labels\":{\"alertname\":\"$STALL_ALERT\",\"severity\":\"critical\"},\"annotations\":{\"summary\":\"$summary\",\"description\":\"$detail\"}}]" \
    >/dev/null 2>&1 || echo "WARN [$(date -Is)] Alertmanager notify failed (curl)" >&2
}

resolve_stall() {
  curl -sf -X POST "$ALERTMANAGER_URL/api/v2/alerts" \
    -H 'Content-Type: application/json' \
    -d "[{\"labels\":{\"alertname\":\"$STALL_ALERT\",\"severity\":\"critical\"},\"annotations\":{},\"endsAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}]" \
    >/dev/null 2>&1 || true
}

if ! git fetch origin main; then
  echo "ERROR [$(date -Is)] git fetch origin main failed — staying on $(git rev-parse HEAD 2>/dev/null || echo unknown)" >&2
  echo "$(date -Is) fetch_failed $(git rev-parse HEAD 2>/dev/null || echo unknown)" > "$STALL_MARKER"
  notify_alert \
    "VPS self-pull stalled (git fetch failed)" \
    "git fetch origin main failed at $(date -Is); repo stays at $(git rev-parse HEAD 2>/dev/null || echo unknown); next cron tick retries."
  exit 1
fi

git reset --hard origin/main

if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  echo "ERROR [$(date -Is)] checkout stale: HEAD=$(git rev-parse HEAD) origin/main=$(git rev-parse origin/main)" >&2
  echo "$(date -Is) stale_checkout $(git rev-parse HEAD 2>/dev/null || echo unknown)" > "$STALL_MARKER"
  notify_alert \
    "VPS self-pull stalled (stale checkout)" \
    "HEAD $(git rev-parse HEAD) != origin/main $(git rev-parse origin/main) after reset at $(date -Is)."
  exit 1
fi

if [ -f "$STALL_MARKER" ]; then
  echo "Recovered from previous stall ($(cat "$STALL_MARKER"))"
  rm -f "$STALL_MARKER"
  resolve_stall
fi

NEW_SHA=$(git rev-parse HEAD)

echo "$GHCR_PULL_TOKEN" | docker login "$REGISTRY" -u "$GHCR_USER" --password-stdin >/dev/null 2>&1 || true

# app -> "health_path:run_migrations"
declare -A APPS=(
  [messenger-bot]="/health/ready:true"
  [discord-bot]="/health/ready:false"
  [zalo-bot]="/health/ready:false"
)

for app in "${!APPS[@]}"; do
  IFS=':' read -r health_path run_migrations <<< "${APPS[$app]}"
  target_dir="$TARGET_BASE_DIR/${app}"
  image="${REGISTRY}/${REPO_LC}/${app}:${NEW_SHA}"
  state_file="$STATE_DIR/${app}.sha"

  if [ -f "$state_file" ] && [ "$(cat "$state_file")" = "$NEW_SHA" ]; then
    continue
  fi

  if ! docker manifest inspect "$image" >/dev/null 2>&1; then
    echo "$app: $image not published yet — will retry next run"
    continue
  fi

  echo "=== Deploying $app @ $NEW_SHA ==="
  mkdir -p "$target_dir/upstreams"
  cp "$REPO_DIR/apps/${app}/docker-compose.prod.yml" "$target_dir/"
  cp "$REPO_DIR/.github/scripts/vps-deploy.sh" "$target_dir/"
  cp "$REPO_DIR/deploy/nginx/upstreams/${app}.conf" "$target_dir/upstreams/" 2>/dev/null || true

  migration_cmd=""
  if [ "$run_migrations" = "true" ]; then
    migration_cmd="npx --no-install typeorm migration:run -d apps/messenger-bot/dist/infrastructure/database/data-source.js"
  fi

  if (
    cd "$target_dir"
    IMAGE="$image" DEPLOY_MODE=self-pull APP_NAME="$app" HEALTH_PATH="$health_path" \
    GHCR_PULL_TOKEN="$GHCR_PULL_TOKEN" GHCR_USER="$GHCR_USER" \
    RUN_MIGRATIONS="$run_migrations" MIGRATION_CMD="$migration_cmd" \
    NGINX_UPSTREAM_DIR="$NGINX_UPSTREAM_DIR" \
    bash vps-deploy.sh
  ); then
    echo "$NEW_SHA" > "$state_file"
  else
    echo "ERROR: deploy failed for $app @ $NEW_SHA — will retry next run" >&2
  fi
done
