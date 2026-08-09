#!/usr/bin/env bash
set -euo pipefail

# Zero-downtime VPS deploy script for all WISPACE bots.
# Runs in the deploy dir (cwd) containing docker-compose.prod.yml (+ optional production.env).
#
# Flow: start new container → health check → switch nginx → monitor → stop old
#
# Requires env: IMAGE, DEPLOY_MODE, APP_NAME
# Optional env: FORCE_RECREATE, GHCR_PULL_TOKEN, GHCR_USER, HEALTH_PATH, PORT,
#               HEALTH_MAX_ATTEMPTS, DEPLOY_HOST_DIR, RUN_MIGRATIONS, MIGRATION_CMD,
#               MIGRATION_DB_CONTAINER, MIGRATION_LOCK_ID, NGINX_UPSTREAM_DIR

: "${IMAGE:?IMAGE is required}"
: "${DEPLOY_MODE:?DEPLOY_MODE is required}"
: "${APP_NAME:?APP_NAME is required}"
: "${FORCE_RECREATE:=false}"
: "${GHCR_PULL_TOKEN:-}"
: "${GHCR_USER:-}"
: "${HEALTH_PATH:=/health}"                   # health check path (empty skips)
: "${HEALTH_MAX_ATTEMPTS:=30}"             # health check attempts before rollback
: "${PORT:=5007}"                          # default port (compose overrides via .env)
: "${DEPLOY_HOST_DIR:=/home/ngoc_anh/${APP_NAME}}"
: "${NGINX_UPSTREAM_DIR:=/home/ngoc_anh/infra/nginx/upstreams}"
: "${POST_SWITCH_MONITOR_ATTEMPTS:=24}"    # monitor after switch (24 × 5s = 2 min)
: "${POST_SWITCH_MONITOR_INTERVAL:=5}"     # seconds between post-switch checks

COMPOSE_FILE="docker-compose.prod.yml"

# ─── Port mapping: active ↔ standby ─────────────────────────────────────────
# Each bot has two ports; the deploy toggles between them.
declare -A PORT_MAP=(
  [messenger-bot]="5007:5008"
  [discord-bot]="3001:3002"
  [zalo-bot]="3002:3003"
)

get_standalone_port() {
  local app="$1"
  echo "${PORT_MAP[$app]%%:*}"
}

get_standby_port() {
  local app="$1"
  echo "${PORT_MAP[$app]##*:}"
}

# ─── Prepare .env from production.env (Doppler download from CI) ─────────────
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

# ─── Ensure deploy-owned env vars (idempotent — only fills missing keys) ─────
ensure_env_var() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" .env; then
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

# ─── Read PORT from .env ─────────────────────────────────────────────────────
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

# ─── Authenticate with GHCR ──────────────────────────────────────────────────
if [ -n "${GHCR_PULL_TOKEN:-}" ] && [ -n "${GHCR_USER:-}" ]; then
  echo "$GHCR_PULL_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin 2>/dev/null || true
fi

export IMAGE
export DEPLOY_UID=${DEPLOY_UID:-1001}
export DEPLOY_GID=${DEPLOY_GID:-1001}

# ─── Determine active / standby ports ────────────────────────────────────────
ACTIVE_PORT=$(get_standalone_port "$APP_NAME")
STANDBY_PORT=$(get_standby_port "$APP_NAME")

# If the active container is already on the standby port (previous deploy didn't
# complete the toggle), swap roles so we always deploy to the other port.
ACTIVE_CONTAINER="${APP_NAME}-old"
ACTIVE_CONTAINER_IMAGE=$(docker inspect -f '{{.Config.Image}}' "$ACTIVE_CONTAINER" 2>/dev/null || true)
if [ -n "$ACTIVE_CONTAINER_IMAGE" ]; then
  ACTIVE_CONTAINER_PORT=$(docker inspect -f '{{range $p, $conf := .NetworkSettings.Ports}}{{(index $conf 0).HostPort}}{{end}}' "$ACTIVE_CONTAINER" 2>/dev/null | head -1 || true)
  if [ "$ACTIVE_CONTAINER_PORT" = "$STANDBY_PORT" ]; then
    echo "Active container already on standby port $STANDBY_PORT — swapping ports"
    tmp="$ACTIVE_PORT"
    ACTIVE_PORT="$STANDBY_PORT"
    STANDBY_PORT="$tmp"
  fi
fi

NEW_CONTAINER="${APP_NAME}-new"
echo "Deploy: $APP_NAME"
echo "  Active container:  $ACTIVE_CONTAINER (port $ACTIVE_PORT)"
echo "  New container:     $NEW_CONTAINER (port $STANDBY_PORT)"
echo "  Image:             $IMAGE"

# ─── Pull image ───────────────────────────────────────────────────────────────
if [ "$FORCE_RECREATE" = "true" ]; then
  docker compose -f "$COMPOSE_FILE" pull "$APP_NAME" || true
else
  docker compose -f "$COMPOSE_FILE" pull "$APP_NAME" 2>/dev/null || true
fi

# ─── Start new container on standby port ──────────────────────────────────────
echo "Starting $NEW_CONTAINER on port $STANDBY_PORT ..."
CONTAINER_NAME="$NEW_CONTAINER" PORT="$STANDBY_PORT" \
  docker compose -f "$COMPOSE_FILE" up -d "$APP_NAME"

# ─── Health check new container (before migrations) ──────────────────────────
echo "Health-checking $NEW_CONTAINER (port $STANDBY_PORT) ..."
healthy=""
for attempt in $(seq 1 "${HEALTH_MAX_ATTEMPTS}"); do
  if curl -sf --max-time 3 "http://127.0.0.1:${STANDBY_PORT}${HEALTH_PATH}" >/dev/null 2>&1; then
    healthy=1
    echo "  Health check passed (attempt ${attempt})"
    break
  fi
  sleep 2
done

if [ -z "$healthy" ]; then
  echo "ERROR: New container failed health check — rolling back" >&2
  docker compose -f "$COMPOSE_FILE" logs "$NEW_CONTAINER" --tail 80 2>/dev/null || true
  CONTAINER_NAME="$NEW_CONTAINER" docker compose -f "$COMPOSE_FILE" stop "$APP_NAME" 2>/dev/null || true
  CONTAINER_NAME="$NEW_CONTAINER" docker compose -f "$COMPOSE_FILE" rm -f "$APP_NAME" 2>/dev/null || true
  exit 1
fi

# ─── Run migrations inside new container (before switching traffic) ───────────
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
    # Safety net: quick pg_dump before migrations
    PRE_MIGRATE_DIR="${PRE_MIGRATE_DIR:-/home/ngoc_anh/backups/ai_chat_bot_db/pre-migrate}"
    mkdir -p "$PRE_MIGRATE_DIR"
    PRE_MIGRATE_DUMP="$PRE_MIGRATE_DIR/pre-migrate-$(date +%Y%m%d-%H%M%S).dump"
    echo "Pre-migration safety dump → $PRE_MIGRATE_DUMP"
    docker exec -e PGPASSWORD="$DB_PASSWORD_ENV" "$MIGRATION_DB_CONTAINER" \
      pg_dump -U "$DB_USER_ENV" -d "$DB_NAME_ENV" -h localhost -Fc \
      > "$PRE_MIGRATE_DUMP" 2>/dev/null || echo "WARNING: pre-migration dump failed — proceeding anyway"
    find "$PRE_MIGRATE_DIR" -name 'pre-migrate-*.dump' -mtime +1 -delete 2>/dev/null || true

    # Run migrations inside the NEW container
    if CONTAINER_NAME="$NEW_CONTAINER" docker compose -f "$COMPOSE_FILE" exec -T "$APP_NAME" \
      sh -c "cd /app && $MIGRATION_CMD"; then
      echo "Migrations applied OK"
    else
      echo "ERROR: migrations failed — rolling back" >&2
      lock_db "SELECT pg_advisory_unlock($MIGRATION_LOCK_ID)" || true
      CONTAINER_NAME="$NEW_CONTAINER" docker compose -f "$COMPOSE_FILE" stop "$APP_NAME" 2>/dev/null || true
      CONTAINER_NAME="$NEW_CONTAINER" docker compose -f "$COMPOSE_FILE" rm -f "$APP_NAME" 2>/dev/null || true
      exit 1
    fi
    lock_db "SELECT pg_advisory_unlock($MIGRATION_LOCK_ID)" || true
  else
    echo "WARNING: RUN_MIGRATIONS enabled but DB password / postgres container unavailable — skipping migrations"
  fi
fi

# ─── Sync upstream config from upload bundle to nginx dir ─────────────────────
# The CI workflow uploads upstreams/${APP_NAME}.conf into the deploy dir.
# Copy it to the live nginx upstreams dir so nginx picks it up.
UPLOAD_UPSTREAM="$(pwd)/upstreams/${APP_NAME}.conf"
mkdir -p "$NGINX_UPSTREAM_DIR"
if [ -f "$UPLOAD_UPSTREAM" ]; then
  cp "$UPLOAD_UPSTREAM" "$NGINX_UPSTREAM_DIR/"
  echo "Synced upstream config → $NGINX_UPSTREAM_DIR/${APP_NAME}.conf"
fi

# ─── Switch nginx upstream to new container ───────────────────────────────────
UPSTREAM_CONF="${NGINX_UPSTREAM_DIR}/${APP_NAME}.conf"
if [ -f "$UPSTREAM_CONF" ]; then
  echo "Switching nginx upstream → 127.0.0.1:${STANDBY_PORT}"
  sed -i "s/server 127.0.0.1:[0-9]*/server 127.0.0.1:${STANDBY_PORT}/" "$UPSTREAM_CONF"
  nginx -s reload 2>/dev/null || sudo nginx -s reload 2>/dev/null || {
    echo "WARNING: nginx reload failed — traffic may still go to old container"
  }
else
  echo "WARNING: upstream conf not found at $UPSTREAM_CONF — skipping nginx switch"
fi

# ─── Post-switch health monitor (2 minutes) ──────────────────────────────────
echo "Monitoring health on port $STANDBY_PORT for $(( POST_SWITCH_MONITOR_ATTEMPTS * POST_SWITCH_MONITOR_INTERVAL ))s ..."
monitor_healthy=""
for attempt in $(seq 1 "${POST_SWITCH_MONITOR_ATTEMPTS}"); do
  if curl -sf --max-time 3 "http://127.0.0.1:${STANDBY_PORT}${HEALTH_PATH}" >/dev/null 2>&1; then
    monitor_healthy=1
  else
    echo "  Monitor check failed (attempt ${attempt}/${POST_SWITCH_MONITOR_ATTEMPTS})"
    monitor_healthy=""
    break
  fi
  sleep "${POST_SWITCH_MONITOR_INTERVAL}"
done

if [ -z "$monitor_healthy" ]; then
  echo "ERROR: Post-switch health check failed — rolling back nginx to port $ACTIVE_PORT" >&2
  if [ -f "$UPSTREAM_CONF" ]; then
    sed -i "s/server 127.0.0.1:[0-9]*/server 127.0.0.1:${ACTIVE_PORT}/" "$UPSTREAM_CONF"
    nginx -s reload 2>/dev/null || sudo nginx -s reload 2>/dev/null || true
  fi
  # Stop the failed new container
  CONTAINER_NAME="$NEW_CONTAINER" docker compose -f "$COMPOSE_FILE" stop "$APP_NAME" 2>/dev/null || true
  CONTAINER_NAME="$NEW_CONTAINER" docker compose -f "$COMPOSE_FILE" rm -f "$APP_NAME" 2>/dev/null || true
  exit 1
fi

echo "Post-switch health OK — new container stable"

# ─── Stop old container ──────────────────────────────────────────────────────
if [ -n "$ACTIVE_CONTAINER_IMAGE" ]; then
  echo "Stopping old container: $ACTIVE_CONTAINER"
  docker stop "$ACTIVE_CONTAINER" 2>/dev/null || true
  docker rm "$ACTIVE_CONTAINER" 2>/dev/null || true
fi

# ─── Rename new container → old (for next deploy) ────────────────────────────
if docker inspect "$NEW_CONTAINER" >/dev/null 2>&1; then
  docker rename "$NEW_CONTAINER" "$ACTIVE_CONTAINER" 2>/dev/null || true
fi

echo "✓ Deploy complete: $APP_NAME ($IMAGE) on port $STANDBY_PORT"
