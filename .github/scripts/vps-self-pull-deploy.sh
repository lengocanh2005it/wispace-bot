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
#   */2 * * * * cd ~/wispace-bot-src && git fetch origin main --quiet && git reset --hard origin/main --quiet && \
#     GHCR_USER=<owner> GHCR_PULL_TOKEN=<PAT read:packages> \
#     bash .github/scripts/vps-self-pull-deploy.sh >> ~/vps-self-pull-deploy.log 2>&1
#
# The git fetch/reset MUST happen in the crontab line, not inside this
# script: cron invokes this file by path, so if the file doesn't exist yet
# in the clone (first bootstrap, or after the clone dir is recreated), the
# script itself can never run to pull the update that would create it.
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

: "${GHCR_USER:?GHCR_USER is required}"
: "${GHCR_PULL_TOKEN:?GHCR_PULL_TOKEN is required}"

mkdir -p "$STATE_DIR"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "Another self-pull run is still in progress — skipping"
  exit 0
fi

cd "$REPO_DIR"
NEW_SHA=$(git rev-parse HEAD)

echo "$GHCR_PULL_TOKEN" | docker login "$REGISTRY" -u "$GHCR_USER" --password-stdin >/dev/null 2>&1 || true

# app -> "target_dir:health_path:run_migrations"
declare -A APPS=(
  [messenger-bot]="/home/ngoc_anh/messenger-bot:/health/ready:true"
  [discord-bot]="/home/ngoc_anh/discord-bot:/health/ready:false"
  [zalo-bot]="/home/ngoc_anh/zalo-bot:/health/ready:false"
)

for app in "${!APPS[@]}"; do
  IFS=':' read -r target_dir health_path run_migrations <<< "${APPS[$app]}"
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
