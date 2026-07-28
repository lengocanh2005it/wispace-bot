#!/usr/bin/env bash
set -euo pipefail

# Zalo bot VPS deploy script
# Called remotely via ssh-deploy-vps.sh
# Expects: IMAGE, DEPLOY_MODE, FORCE_RECREATE, GHCR_PULL_TOKEN, GHCR_USER

: "${IMAGE:?IMAGE is required}"
: "${DEPLOY_MODE:?DEPLOY_MODE is required}"
: "${FORCE_RECREATE:=false}"
: "${GHCR_PULL_TOKEN:-}"
: "${GHCR_USER:-}"

COMPOSE_FILE="docker-compose.prod.yml"

# Authenticate with GHCR for docker pull inside the VPS
if [ -n "${GHCR_PULL_TOKEN:-}" ] && [ -n "${GHCR_USER:-}" ]; then
  echo "$GHCR_PULL_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin 2>/dev/null || true
fi

export IMAGE
export DEPLOY_UID=${DEPLOY_UID:-1001}
export DEPLOY_GID=${DEPLOY_GID:-1001}

if [ "$FORCE_RECREATE" = "true" ]; then
  docker compose -f "$COMPOSE_FILE" pull zalo-bot || true
  docker compose -f "$COMPOSE_FILE" up -d --force-recreate zalo-bot
else
  docker compose -f "$COMPOSE_FILE" pull zalo-bot 2>/dev/null || true
  docker compose -f "$COMPOSE_FILE" up -d zalo-bot
fi

echo "Deploy complete: zalo-bot ($IMAGE)"
