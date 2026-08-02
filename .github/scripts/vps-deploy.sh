#!/usr/bin/env bash
set -euo pipefail

# Unified VPS deploy script for all WISPACE bots.
# Runs in the deploy dir (cwd) containing docker-compose.prod.yml (+ optional production.env).
# Requires env: IMAGE, DEPLOY_MODE, APP_NAME
# Optional env: FORCE_RECREATE, GHCR_PULL_TOKEN, GHCR_USER, HEALTH_PATH, PORT, DEPLOY_HOST_DIR

: "${IMAGE:?IMAGE is required}"
: "${DEPLOY_MODE:?DEPLOY_MODE is required}"
: "${APP_NAME:?APP_NAME is required}"
: "${FORCE_RECREATE:=false}"
: "${GHCR_PULL_TOKEN:-}"
: "${GHCR_USER:-}"
: "${HEALTH_PATH:=}"                       # e.g. /health/db — empty skips the health check
: "${PORT:=5007}"                          # health check port (compose overrides via .env PORT=)
: "${DEPLOY_HOST_DIR:=/home/ngoc_anh/${APP_NAME}}"

COMPOSE_FILE="docker-compose.prod.yml"

# Prepare .env from production.env if present (Doppler download from CI)
if [ -f "production.env" ]; then
  DEPLOY_UID=$(id -u)
  DEPLOY_GID=$(id -g)
  cp production.env .env
  grep -v '^DEPLOY_UID=' .env > .env.tmp || true
  echo "DEPLOY_UID=${DEPLOY_UID}" >> .env.tmp
  grep -v '^DEPLOY_GID=' .env.tmp > .env2 || true
  echo "DEPLOY_GID=${DEPLOY_GID}" >> .env2
  mv .env2 .env
  rm -f .env.tmp production.env
  echo ".env installed ($(wc -l < .env) lines)"
fi

if [ ! -f ".env" ]; then
  echo "WARNING: No .env file found — docker compose may fail"
fi

# Ensure deploy-owned env vars (idempotent — only fills missing keys)
ensure_env_var() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" .env; then
    # Delimiter is '#' (not '/') because several values are filesystem
    # paths (e.g. DEPLOY_DIR=/deploy) which would break a '/'-delimited s///.
    sed -i "s#^${key}=.*#${key}=${value}#" .env
  else
    printf '\n%s=%s\n' "$key" "$value" >> .env
  fi
}

ensure_env_var CHAT_RATE_LIMIT_ENABLED true
ensure_env_var ENFORCE_PROD_CHAT_QUOTA true
ensure_env_var DOPPLER_RUNTIME_SYNC_ENABLED true
ensure_env_var DEPLOY_DIR /deploy
ensure_env_var DEPLOY_HOST_DIR "$DEPLOY_HOST_DIR"
ensure_env_var DEPLOY_ENV_FILE /deploy/.env
ensure_env_var DEPLOY_COMPOSE_FILE /deploy/docker-compose.prod.yml
ensure_env_var DEPLOY_UID "$(id -u)"
ensure_env_var DEPLOY_GID "$(id -g)"
if [ -S /var/run/docker.sock ]; then
  ensure_env_var DOCKER_GID "$(stat -c '%g' /var/run/docker.sock)"
fi
if ! grep -q '^HOME=' .env; then
  ensure_env_var HOME /tmp
fi

# Read PORT from .env (compose default differs per bot: 5007/3001/3002)
if [ -f .env ]; then
  env_port=$(grep -E '^PORT=' .env | tail -1 | cut -d= -f2- | tr -d '\r')
  env_port="${env_port%\"}"
  env_port="${env_port#\"}"
  env_port="${env_port%\'}"
  env_port="${env_port#\'}"
  if [ -n "$env_port" ]; then
    PORT="$env_port"
  fi
fi

# Authenticate with GHCR for pulling the private image
if [ -n "${GHCR_PULL_TOKEN:-}" ] && [ -n "${GHCR_USER:-}" ]; then
  echo "$GHCR_PULL_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin 2>/dev/null || true
fi

export IMAGE
export DEPLOY_UID=${DEPLOY_UID:-1001}
export DEPLOY_GID=${DEPLOY_GID:-1001}

if [ "$FORCE_RECREATE" = "true" ]; then
  docker compose -f "$COMPOSE_FILE" pull "$APP_NAME" || true
  docker compose -f "$COMPOSE_FILE" up -d --force-recreate "$APP_NAME"
else
  docker compose -f "$COMPOSE_FILE" pull "$APP_NAME" 2>/dev/null || true
  docker compose -f "$COMPOSE_FILE" up -d "$APP_NAME"
fi

echo "Deploy complete: $APP_NAME ($IMAGE)"

# Optional health check (Messenger exposes /health/db; Discord/Zalo skip)
if [ -n "$HEALTH_PATH" ]; then
  for attempt in $(seq 1 30); do
    if curl -sf "http://127.0.0.1:${PORT}${HEALTH_PATH}" >/dev/null; then
      echo "Health check passed on attempt ${attempt}"
      exit 0
    fi
    sleep 2
  done
  echo "ERROR: Health check failed" >&2
  docker compose -f "$COMPOSE_FILE" logs "$APP_NAME" --tail 80 || true
  exit 1
fi
