#!/usr/bin/env bash
set -euo pipefail

DEPLOY_PATH="${DEPLOY_PATH:-/home/ngoc_anh/messenger-bot}"
PORT=5007

read_port_from_env() {
  local env_file="$1"
  local env_port
  if [ -f "$env_file" ]; then
    env_port=$(grep -E '^PORT=' "$env_file" | tail -1 | cut -d= -f2- | tr -d '\r')
    env_port="${env_port%\"}"
    env_port="${env_port#\"}"
    env_port="${env_port%\'}"
    env_port="${env_port#\'}"
    if [ -n "$env_port" ]; then
      PORT="$env_port"
    fi
  fi
}

ensure_production_env_vars() {
  local env_file="$1"
  if [ ! -f "$env_file" ]; then
    return 0
  fi

  set_env_var() {
    local key="$1"
    local value="$2"
    if grep -q "^${key}=" "$env_file"; then
      # Delimiter is '#' (not '/') because several values are filesystem
      # paths (e.g. DEPLOY_DIR=/deploy) which would break a '/'-delimited s///.
      sed -i "s#^${key}=.*#${key}=${value}#" "$env_file"
    else
      printf '\n%s=%s\n' "$key" "$value" >> "$env_file"
    fi
  }

  set_env_var CHAT_RATE_LIMIT_ENABLED true
  set_env_var ENFORCE_PROD_CHAT_QUOTA true
  set_env_var DOPPLER_RUNTIME_SYNC_ENABLED true
  set_env_var DEPLOY_DIR /deploy
  set_env_var DEPLOY_HOST_DIR /home/ngoc_anh/messenger-bot
  set_env_var DEPLOY_ENV_FILE /deploy/.env
  set_env_var DEPLOY_COMPOSE_FILE /deploy/docker-compose.prod.yml
  set_env_var DEPLOY_UID "$(id -u)"
  set_env_var DEPLOY_GID "$(id -g)"
  set_env_var DOCKER_GID "$(stat -c '%g' /var/run/docker.sock)"
  if ! grep -q '^HOME=' "$env_file"; then
    set_env_var HOME /tmp
  fi

  echo "Ensured production env flags and deploy paths in .env"
}

apply_doppler_env_from_ci() {
  if [ ! -f "$DEPLOY_PATH/production.env" ]; then
    return 0
  fi

  install -m 600 "$DEPLOY_PATH/production.env" "$DEPLOY_PATH/.env"
  rm -f "$DEPLOY_PATH/production.env"
  echo "Applied .env from Doppler (CI)"
}

health_check() {
  local attempt
  for attempt in $(seq 1 30); do
    if curl -sf "http://127.0.0.1:${PORT}/health/db" >/dev/null; then
      echo "Health check passed on attempt ${attempt}"
      return 0
    fi
    sleep 2
  done
  return 1
}

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker is not installed on VPS"
  exit 1
fi

if docker info >/dev/null 2>&1; then
  DOCKER="docker"
elif sudo docker info >/dev/null 2>&1; then
  DOCKER="sudo docker"
  echo "Using sudo for docker (user not in docker group)"
else
  echo "ERROR: cannot access docker API (try: sudo usermod -aG docker $USER)"
  exit 1
fi

cd "$DEPLOY_PATH"
apply_doppler_env_from_ci

if [ ! -f .env ]; then
  if [ -f publish/.env ]; then
    cp publish/.env .env
    echo "Migrated .env from legacy publish/ path"
  else
    echo "ERROR: No .env found under $DEPLOY_PATH"
    exit 1
  fi
fi

ensure_production_env_vars .env
read_port_from_env .env
echo "Listening port: $PORT"
echo "Deploy mode: ${DEPLOY_MODE:-unknown}"
echo "Image: ${IMAGE:?IMAGE is required}"

if [ -n "${GHCR_PULL_TOKEN:-}" ]; then
  echo "$GHCR_PULL_TOKEN" | $DOCKER login ghcr.io -u "$GHCR_USER" --password-stdin
else
  echo "WARNING: GHCR_PULL_TOKEN not set — pull may fail for private images"
fi

export IMAGE
export PORT

echo "Pulling image: $IMAGE"
$DOCKER compose -f docker-compose.prod.yml pull

if command -v pm2 >/dev/null 2>&1; then
  pm2 delete messenger-bot >/dev/null 2>&1 || true
fi

RECREATE_FLAGS=(up -d --remove-orphans)
if [ "${FORCE_RECREATE:-false}" = "true" ]; then
  RECREATE_FLAGS=(up -d --force-recreate --remove-orphans)
fi

echo "Starting container"
$DOCKER compose -f docker-compose.prod.yml "${RECREATE_FLAGS[@]}"

$DOCKER compose -f docker-compose.prod.yml ps
$DOCKER logs messenger-bot --tail 40 || true

if health_check; then
  echo "Deployment complete — container messenger-bot is healthy"
else
  echo "ERROR: Health check failed"
  $DOCKER logs messenger-bot --tail 80 || true
  exit 1
fi
