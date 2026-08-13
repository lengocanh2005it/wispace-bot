#!/usr/bin/env bash
set -euo pipefail

# Zero-downtime VPS deploy script for all WISPACE bots.
# Runs in the deploy dir (cwd) containing docker-compose.prod.yml (+ optional production.env).
#
# Flow: start new container (docker run, NOT compose — compose would recreate
# the old container instead of running both side by side) → health check →
# switch nginx → monitor → stop old.
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
: "${HEALTH_MAX_ATTEMPTS:=30}"                # health check attempts before rollback
: "${PORT:=5007}"                             # default port (overridden from .env)
: "${DEPLOY_HOST_DIR:=/home/ngoc_anh/${APP_NAME}}"
: "${NGINX_UPSTREAM_DIR:=/home/ngoc_anh/infra/nginx/upstreams}"
: "${POST_SWITCH_MONITOR_ATTEMPTS:=24}"       # monitor after switch (24 × 5s = 2 min)
: "${POST_SWITCH_MONITOR_INTERVAL:=5}"        # seconds between post-switch checks

COMPOSE_FILE="docker-compose.prod.yml"

# ─── Per-app config: port pairs + docker run resources ─────────────────────────
# Format: ACTIVE:STANDBY;MEM;CPUS;VOL1;VOL2;...
# (volumes are ';'-separated so the ':' inside volume specs is safe)
declare -A APP_CFG=(
  [messenger-bot]="5007:5008;512m;1.0;"
  [discord-bot]="3001:3004;256m;0.5;"
  [zalo-bot]="3002:3003;256m;0.5;"
)

get_standalone_port() {
  local app="$1" ports
  ports="${APP_CFG[$app]%%;*}"
  echo "${ports%%:*}"
}

get_standby_port() {
  local app="$1" ports
  ports="${APP_CFG[$app]%%;*}"
  echo "${ports##*:}"
}

get_mem() {
  local app="$1" rest
  rest="${APP_CFG[$app]#*;}"
  echo "${rest%%;*}"
}

get_cpus() {
  local app="$1" rest
  rest="${APP_CFG[$app]#*;}"
  rest="${rest#*;}"
  echo "${rest%%;*}"
}

get_extra_volumes() {
  local app="$1" rest
  rest="${APP_CFG[$app]#*;}"
  rest="${rest#*;}"
  rest="${rest#*;}"
  echo "$rest"
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
  echo "WARNING: No .env file found — container will have no env"
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
ensure_env_var DOPPLER_RUNTIME_SYNC_ENABLED false
ensure_env_var DEPLOY_UID "$(id -u)"
ensure_env_var DEPLOY_GID "$(id -g)"
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

DEPLOY_UID=${DEPLOY_UID:-$(id -u)}
DEPLOY_GID=${DEPLOY_GID:-$(id -g)}
# ensure_env_var wrote these into .env, but they are not shell variables yet
# ─── Prepare env file for docker run (strip quotes) ───────────────────────────
# docker run --env-file does NOT strip surrounding quotes like compose does,
# and Doppler downloads values as KEY="value" — strip them here.
ENV_FILE="/tmp/${APP_NAME}.docker-env"
sed 's/^\([A-Za-z_][A-Za-z0-9_]*\)="\(.*\)"$/\1=\2/' .env > "$ENV_FILE"

# ─── Determine active / standby ports ────────────────────────────────────────
ACTIVE_PORT=$(get_standalone_port "$APP_NAME")
STANDBY_PORT=$(get_standby_port "$APP_NAME")

# Active container: prefer ${APP_NAME}-old; fall back to ${APP_NAME} (first
# deploy after the migration, when containers were not suffixed yet).
ACTIVE_CONTAINER="${APP_NAME}-old"
if ! docker inspect "$ACTIVE_CONTAINER" >/dev/null 2>&1; then
  if docker inspect "$APP_NAME" >/dev/null 2>&1; then
    ACTIVE_CONTAINER="$APP_NAME"
  else
    ACTIVE_CONTAINER=""
  fi
fi

ACTIVE_CONTAINER_IMAGE=""
ACTIVE_CONTAINER_PORT=""
if [ -n "$ACTIVE_CONTAINER" ]; then
  ACTIVE_CONTAINER_IMAGE=$(docker inspect -f '{{.Config.Image}}' "$ACTIVE_CONTAINER" 2>/dev/null || true)
  ACTIVE_CONTAINER_PORT=$(docker port "$ACTIVE_CONTAINER" 2>/dev/null | head -1 | grep -oE '[0-9]+$' || true)
  # If the active container is already on the standby port (previous deploy
  # switched but naming lagged), swap roles so we always deploy to the other port.
  if [ "$ACTIVE_CONTAINER_PORT" = "$STANDBY_PORT" ]; then
    echo "Active container already on standby port $STANDBY_PORT — swapping ports"
    tmp="$ACTIVE_PORT"
    ACTIVE_PORT="$STANDBY_PORT"
    STANDBY_PORT="$tmp"
  fi
fi

NEW_CONTAINER="${APP_NAME}-new"
echo "Deploy: $APP_NAME"
echo "  Active container:  ${ACTIVE_CONTAINER:-<none>} (port $ACTIVE_PORT)"
echo "  New container:     $NEW_CONTAINER (port $STANDBY_PORT)"
echo "  Image:             $IMAGE"

# Clean leftover container from a failed deploy
docker rm -f "$NEW_CONTAINER" >/dev/null 2>&1 || true

# ─── Pull image ───────────────────────────────────────────────────────────────
docker pull "$IMAGE" 2>/dev/null || docker pull "$IMAGE" || true

# ─── Start new container on standby port (docker run, NOT compose) ────────────
# Compose would "recreate" the old container (it matches by project/service
# labels), killing it instead of running both side by side.
echo "Starting $NEW_CONTAINER on port $STANDBY_PORT ..."

RUN_ARGS=(
  -d
  --name "$NEW_CONTAINER"
  --restart unless-stopped
  --user "${DEPLOY_UID}:${DEPLOY_GID}"
  --env-file "$ENV_FILE"
  -e HOME=/tmp
  -e PORT="${STANDBY_PORT}"
  -p "127.0.0.1:${STANDBY_PORT}:${STANDBY_PORT}"
  --memory "$(get_mem "$APP_NAME")"
  --cpus "$(get_cpus "$APP_NAME")"
)

EXTRA_VOLUMES="$(get_extra_volumes "$APP_NAME")"
if [ -n "$EXTRA_VOLUMES" ]; then
  IFS=';' read -r -a VOL_ARRAY <<< "$EXTRA_VOLUMES"
  for vol in "${VOL_ARRAY[@]}"; do
    [ -n "$vol" ] && RUN_ARGS+=(-v "$vol")
  done
fi

RUN_ARGS+=(--cap-drop ALL --security-opt no-new-privileges:true)

if ! docker run "${RUN_ARGS[@]}" "$IMAGE"; then
  echo "ERROR: docker run failed for $NEW_CONTAINER" >&2
  docker logs "$NEW_CONTAINER" --tail 60 2>/dev/null || true
  exit 1
fi

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
  docker logs "$NEW_CONTAINER" --tail 80 2>/dev/null || true
  docker rm -f "$NEW_CONTAINER" >/dev/null 2>&1 || true
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

    case "$MIGRATION_CMD" in
      'npx --no-install typeorm migration:run -d apps/messenger-bot/dist/infrastructure/database/data-source.js')
        migration_status=0
        docker exec "$NEW_CONTAINER" npx --no-install typeorm migration:run \
          -d apps/messenger-bot/dist/infrastructure/database/data-source.js || migration_status=$?
        ;;
      *)
        echo "ERROR: unsupported migration command" >&2
        migration_status=1
        ;;
    esac
    if [ "$migration_status" -eq 0 ]; then
      echo "Migrations applied OK"
    else
      echo "ERROR: migrations failed — rolling back" >&2
      lock_db "SELECT pg_advisory_unlock($MIGRATION_LOCK_ID)" || true
      docker rm -f "$NEW_CONTAINER" >/dev/null 2>&1 || true
      exit 1
    fi
    lock_db "SELECT pg_advisory_unlock($MIGRATION_LOCK_ID)" || true
  else
    echo "WARNING: RUN_MIGRATIONS enabled but DB password / postgres container unavailable — skipping migrations"
  fi
fi

# ─── Sync upstream config from upload bundle to nginx dir ─────────────────────
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
  if ! sudo nginx -s reload 2>/dev/null; then
    echo "ERROR: nginx reload failed — rolling back upstream" >&2
    sed -i "s/server 127.0.0.1:[0-9]*/server 127.0.0.1:${ACTIVE_PORT}/" "$UPSTREAM_CONF"
    docker rm -f "$NEW_CONTAINER" >/dev/null 2>&1 || true
    exit 1
  fi
else
  echo "WARNING: upstream conf not found at $UPSTREAM_CONF — skipping nginx switch"
fi

# ─── Post-switch health monitor (2 minutes) ──────────────────────────────────
echo "Monitoring health on port $STANDBY_PORT for $(( POST_SWITCH_MONITOR_ATTEMPTS * POST_SWITCH_MONITOR_INTERVAL ))s ..."
monitor_healthy=""
monitor_failures=0
MONITOR_MAX_FAILURES="${MONITOR_MAX_FAILURES:-3}"
for attempt in $(seq 1 "${POST_SWITCH_MONITOR_ATTEMPTS}"); do
  if curl -sf --max-time 3 "http://127.0.0.1:${STANDBY_PORT}${HEALTH_PATH}" >/dev/null 2>&1; then
    monitor_healthy=1
    monitor_failures=0
  else
    # Tolerate transient blips (e.g. a short Redis hiccup making /health 503)
    # — only roll back after MONITOR_MAX_FAILURES consecutive failures.
    monitor_failures=$((monitor_failures + 1))
    echo "  Monitor check failed (attempt ${attempt}/${POST_SWITCH_MONITOR_ATTEMPTS}, consecutive=${monitor_failures}/${MONITOR_MAX_FAILURES})"
    if [ "$monitor_failures" -ge "$MONITOR_MAX_FAILURES" ]; then
      monitor_healthy=""
      break
    fi
  fi
  sleep "${POST_SWITCH_MONITOR_INTERVAL}"
done

if [ -z "$monitor_healthy" ]; then
  echo "ERROR: Post-switch health check failed — rolling back nginx to port $ACTIVE_PORT" >&2
  if [ -f "$UPSTREAM_CONF" ]; then
    sed -i "s/server 127.0.0.1:[0-9]*/server 127.0.0.1:${ACTIVE_PORT}/" "$UPSTREAM_CONF"
    sudo nginx -s reload 2>/dev/null || true
  fi
  docker rm -f "$NEW_CONTAINER" >/dev/null 2>&1 || true
  exit 1
fi

echo "Post-switch health OK — new container stable"

# ─── Stop old container ──────────────────────────────────────────────────────
if [ -n "$ACTIVE_CONTAINER" ] && [ -n "$ACTIVE_CONTAINER_IMAGE" ]; then
  echo "Stopping old container: $ACTIVE_CONTAINER"
  docker stop "$ACTIVE_CONTAINER" 2>/dev/null || true
  docker rm "$ACTIVE_CONTAINER" 2>/dev/null || true
fi

# ─── Rename new container → old (for next deploy) ────────────────────────────
if docker inspect "$NEW_CONTAINER" >/dev/null 2>&1; then
  docker rename "$NEW_CONTAINER" "${APP_NAME}-old" 2>/dev/null || true
fi

echo "✓ Deploy complete: $APP_NAME ($IMAGE) on port $STANDBY_PORT"
