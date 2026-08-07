#!/usr/bin/env bash
set -euo pipefail

# Unified VPS deploy script for all WISPACE bots.
# Runs in the deploy dir (cwd) containing docker-compose.prod.yml (+ optional production.env).
# Requires env: IMAGE, DEPLOY_MODE, APP_NAME
# Optional env: FORCE_RECREATE, GHCR_PULL_TOKEN, GHCR_USER, HEALTH_PATH, PORT,
#               HEALTH_MAX_ATTEMPTS, DEPLOY_HOST_DIR, RUN_MIGRATIONS, MIGRATION_CMD,
#               MIGRATION_DB_CONTAINER, MIGRATION_LOCK_ID

: "${IMAGE:?IMAGE is required}"
: "${DEPLOY_MODE:?DEPLOY_MODE is required}"
: "${APP_NAME:?APP_NAME is required}"
: "${FORCE_RECREATE:=false}"
: "${GHCR_PULL_TOKEN:-}"
: "${GHCR_USER:-}"
: "${HEALTH_PATH:=}"                       # e.g. /health/db — empty skips the health check
: "${HEALTH_MAX_ATTEMPTS:=30}"             # health check attempts before rollback
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

# Remember the currently running image so we can roll back if the health
# check fails after the switch.
PREV_IMAGE=$(docker inspect -f '{{.Config.Image}}' "$APP_NAME" 2>/dev/null || true)

if [ "$FORCE_RECREATE" = "true" ]; then docker compose -f "$COMPOSE_FILE" pull "$APP_NAME" || true; else docker compose -f "$COMPOSE_FILE" pull "$APP_NAME" 2>/dev/null || true; fi

# Apply DB migrations with the NEW image before switching traffic.
# Guarded by a Postgres advisory lock: all 3 bots share one DB, so a
# simultaneous deploy must never race on the migrations table.
if [ "${RUN_MIGRATIONS:-true}" = "true" ] && [ -n "${MIGRATION_CMD:-}" ]; then
  MIGRATION_DB_CONTAINER="${MIGRATION_DB_CONTAINER:-postgres_n8n_db}"
  MIGRATION_LOCK_ID="${MIGRATION_LOCK_ID:-4242424242}"
  DB_USER_ENV=$(grep -E '^DB_USER=' .env | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
  DB_NAME_ENV=$(grep -E '^DB_NAME=' .env | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
  DB_PASSWORD_ENV=$(grep -E '^DB_PASSWORD=' .env | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
  if [ -n "$DB_PASSWORD_ENV" ] && docker exec "$MIGRATION_DB_CONTAINER" true 2>/dev/null; then
    lock_db() {
      docker exec -e PGPASSWORD="$DB_PASSWORD_ENV" "$MIGRATION_DB_CONTAINER" \
        psql -U "$DB_USER_ENV" -d "$DB_NAME_ENV" -h localhost -q -tAc "$1" >/dev/null
    }
    echo "Applying migrations (advisory lock $MIGRATION_LOCK_ID): $MIGRATION_CMD"
    if ! lock_db "SELECT pg_advisory_lock($MIGRATION_LOCK_ID)"; then
      echo "ERROR: could not acquire migration lock" >&2
      exit 1
    fi
    # Safety net: quick pg_dump before migrations. Keeps ~1 day so a broken
    # migration can be investigated without waiting for the nightly backup.
    # Uses -Fc (custom format) for fast pg_restore.
    PRE_MIGRATE_DIR="${PRE_MIGRATE_DIR:-/home/ngoc_anh/backups/ai_chat_bot_db/pre-migrate}"
    mkdir -p "$PRE_MIGRATE_DIR"
    PRE_MIGRATE_DUMP="$PRE_MIGRATE_DIR/pre-migrate-$(date +%Y%m%d-%H%M%S).dump"
    echo "Pre-migration safety dump → $PRE_MIGRATE_DUMP"
    docker exec -e PGPASSWORD="$DB_PASSWORD_ENV" "$MIGRATION_DB_CONTAINER" \
      pg_dump -U "$DB_USER_ENV" -d "$DB_NAME_ENV" -h localhost -Fc \
      > "$PRE_MIGRATE_DUMP" 2>/dev/null || echo "WARNING: pre-migration dump failed — proceeding anyway"
    find "$PRE_MIGRATE_DIR" -name 'pre-migrate-*.dump' -mtime +1 -delete 2>/dev/null || true
    if docker compose -f "$COMPOSE_FILE" run --rm --no-deps "$APP_NAME" \
      sh -c "cd /app && $MIGRATION_CMD"; then
      echo "Migrations applied OK"
    else
      echo "ERROR: migrations failed" >&2
      lock_db "SELECT pg_advisory_unlock($MIGRATION_LOCK_ID)" || true
      exit 1
    fi
    lock_db "SELECT pg_advisory_unlock($MIGRATION_LOCK_ID)" || true
  else
    echo "WARNING: RUN_MIGRATIONS enabled but DB password / postgres container unavailable — skipping migrations"
  fi
fi

if [ "$FORCE_RECREATE" = "true" ]; then docker compose -f "$COMPOSE_FILE" up -d --force-recreate "$APP_NAME"; else docker compose -f "$COMPOSE_FILE" up -d "$APP_NAME"; fi

echo "Deploy complete: $APP_NAME ($IMAGE)"

# Health check + rollback: if the new image never becomes healthy, fall back
# to the previously running image instead of leaving the bot down.
if [ -n "$HEALTH_PATH" ]; then
  healthy=""
  for attempt in $(seq 1 "${HEALTH_MAX_ATTEMPTS:-30}"); do
    if curl -sf --max-time 3 "http://127.0.0.1:${PORT}${HEALTH_PATH}" >/dev/null; then
      healthy=1
      echo "Health check passed on attempt ${attempt}"
      break
    fi
    sleep 2
  done
  if [ -z "$healthy" ]; then
    echo "ERROR: Health check failed" >&2
    docker compose -f "$COMPOSE_FILE" logs "$APP_NAME" --tail 80 || true
    if [ -n "${PREV_IMAGE:-}" ] && [ "$PREV_IMAGE" != "$IMAGE" ]; then
      echo "Rolling back to previous image: $PREV_IMAGE"
      IMAGE="$PREV_IMAGE" docker compose -f "$COMPOSE_FILE" up -d "$APP_NAME"
      for attempt in $(seq 1 "${HEALTH_MAX_ATTEMPTS:-30}"); do
        if curl -sf --max-time 3 "http://127.0.0.1:${PORT}${HEALTH_PATH}" >/dev/null; then
          echo "Rollback healthy (attempt ${attempt})"
          break
        fi
        sleep 2
      done
    else
      echo "No previous image to roll back to" >&2
    fi
    exit 1
  fi
fi
