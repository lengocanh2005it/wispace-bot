#!/usr/bin/env bash
# Deploy zalo-bot on VPS — called by GitHub Actions via ssh-deploy-vps.sh
# Receives: IMAGE, DEPLOY_MODE, FORCE_RECREATE, GHCR_PULL_TOKEN, GHCR_USER
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DEPLOY_DIR"

echo "=== Zalo Bot deploy ==="
echo "IMAGE=${IMAGE:-<not set>}"
echo "DEPLOY_MODE=${DEPLOY_MODE:-<not set>}"
echo "FORCE_RECREATE=${FORCE_RECREATE:-false}"

# ── 1. Pull image (if GHCR_PULL_TOKEN provided) ────────────────────────
if [ -n "${GHCR_PULL_TOKEN:-}" ] && [ -n "${GHCR_USER:-}" ]; then
  echo "Logging in to GHCR…"
  echo "${GHCR_PULL_TOKEN}" | docker login ghcr.io -u "${GHCR_USER}" --password-stdin
  docker pull "${IMAGE}"
fi

# ── 2. Prepare .env ────────────────────────────────────────────────────
if [ -f production.env ]; then
  # Merge: production.env overwrites, but preserve DEPLOY_* and DOCKER_GID
  DEPLOY_UID=$(id -u)
  DEPLOY_GID=$(id -g)
  MERGED_ENV=$(mktemp)
  # Start from production.env
  cp production.env "$MERGED_ENV"
  # Ensure deploy-owned vars are present
  grep -v '^DEPLOY_UID=' "$MERGED_ENV" > "$MERGED_ENV.tmp" || true
  echo "DEPLOY_UID=${DEPLOY_UID}" >> "$MERGED_ENV.tmp"
  grep -v '^DEPLOY_GID=' "$MERGED_ENV.tmp" > "$MERGED_ENV" || true
  echo "DEPLOY_GID=${DEPLOY_GID}" >> "$MERGED_ENV"
  grep -v '^DOCKER_GID=' "$MERGED_ENV" > "$MERGED_ENV.tmp" || true
  echo "DOCKER_GID=$(getent group docker | cut -d: -f3)" >> "$MERGED_ENV.tmp"
  mv "$MERGED_ENV.tmp" "$MERGED_ENV"
  # Install .env
  install -m 600 "$MERGED_ENV" .env
  rm -f "$MERGED_ENV"
  rm -f production.env
  echo ".env installed ($(wc -l < .env) lines)"
fi

# ── 3. Deploy ──────────────────────────────────────────────────────────
FORCE_FLAG=""
if [ "${FORCE_RECREATE:-false}" = "true" ]; then
  FORCE_FLAG="--force-recreate"
fi

docker compose -f docker-compose.prod.yml up -d $FORCE_FLAG

# ── 4. Health check ────────────────────────────────────────────────────
echo "Waiting for container to be healthy…"
for i in $(seq 1 30); do
  if docker compose -f docker-compose.prod.yml ps | grep -q "Up"; then
    echo "Deployment complete — container zalo-bot is running"
    exit 0
  fi
  sleep 2
done

echo "WARNING: Container may not be healthy yet. Check: docker compose -f docker-compose.prod.yml ps"
exit 1
