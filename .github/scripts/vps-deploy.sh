#!/usr/bin/env bash
set -euo pipefail

# Restrictive umask: .env copies, the docker env file and the pre-migration
# dump all carry secrets/PII — never create them world/group-readable (#204).
umask 077

# Zero-downtime VPS deploy script for all WISPACE bots.
# Runs in the deploy dir (cwd) containing docker-compose.prod.yml (+ optional production.env).
#
# Flow: start new container (docker run, NOT compose — compose would recreate
# the old container instead of running both side by side) → health check →
# switch nginx → monitor → stop old.
#
# Requires env: IMAGE, DEPLOY_MODE, APP_NAME
# Optional env: FORCE_RECREATE, GHCR_PULL_TOKEN, GHCR_USER, HEALTH_PATH,
#               HEALTH_MAX_ATTEMPTS, DEPLOY_HOST_DIR, RUN_MIGRATIONS, MIGRATION_CMD,
#               MIGRATION_DB_CONTAINER, MIGRATION_LOCK_ID, NGINX_UPSTREAM_DIR,
#               PUBLIC_HOST, DOCKER_STOP_TIMEOUT, SKIP_NGINX_CHECK, IMAGE_DIGEST

: "${IMAGE:?IMAGE is required}"
: "${DEPLOY_MODE:?DEPLOY_MODE is required}"
: "${APP_NAME:?APP_NAME is required}"
: "${FORCE_RECREATE:=false}"
: "${GHCR_PULL_TOKEN:-}"
: "${GHCR_USER:-}"
: "${HEALTH_PATH:=/health}"                   # health check path (empty skips)
: "${HEALTH_MAX_ATTEMPTS:=120}"               # 4-minute cold-start window before rollback
: "${DEPLOY_HOST_DIR:=/home/ngoc_anh/${APP_NAME}}"
: "${NGINX_UPSTREAM_DIR:=/home/ngoc_anh/infra/nginx/upstreams}"
: "${POST_SWITCH_MONITOR_ATTEMPTS:=24}"       # monitor after switch (24 × 5s = 2 min)
: "${POST_SWITCH_MONITOR_INTERVAL:=5}"        # seconds between post-switch checks
: "${DOCKER_STOP_TIMEOUT:=60}"                # docker stop/run grace period — app drains 45s (#201)
: "${PUBLIC_HOST:=aiassist.aihubproduction.com}"  # public nginx host used for post-switch verify
: "${SKIP_NGINX_CHECK:=false}"                # first-deploy escape hatch: only without an active container

COMPOSE_FILE="docker-compose.prod.yml"
MONITORING_NETWORK="monitoring"
APP_NETWORK="${APP_NETWORK:-app_n8n_db_network}"
METRICS_PATH="/metrics"

ENV_INSTALL_TMP=""
ENV_FILE=""
PRODUCTION_ENV_PRESENT=false
cleanup_env_install() {
  [ -z "$ENV_INSTALL_TMP" ] || rm -f -- "$ENV_INSTALL_TMP"
  [ -z "$ENV_FILE" ] || rm -f -- "$ENV_FILE"
  [ "$PRODUCTION_ENV_PRESENT" = true ] || return 0
  rm -f -- production.env
}
trap cleanup_env_install EXIT

# Lock down env files before any grep/sed can read them.
if [ -f .env ] && ! chmod 600 .env; then
  echo "ERROR: could not chmod .env to 600 — refusing to deploy" >&2
  exit 1
fi

write_production_env() {
  local grep_status
  if grep -v -E '^(DEPLOY_UID|DEPLOY_GID)=' production.env; then
    :
  else
    grep_status=$?
    [ "$grep_status" -eq 1 ] || return "$grep_status"
  fi
  printf 'DEPLOY_UID=%s\nDEPLOY_GID=%s\n' "$DEPLOY_UID" "$DEPLOY_GID"
}

# ─── Per-app config: port pairs + docker run resources ─────────────────────────
# Format: ACTIVE:STANDBY:CONTAINER;MEM;CPUS;VOL1;VOL2;...
# (volumes are ';'-separated so the ':' inside volume specs is safe)
declare -A APP_CFG=(
  [messenger-bot]="5007:5008:5007;512m;1.0;"
  [discord-bot]="3001:3004:3001;256m;0.5;"
  [zalo-bot]="3002:3003:3002;256m;0.5;"
)

if [[ -z "${APP_CFG[$APP_NAME]+configured}" ]]; then
  echo "ERROR: unsupported APP_NAME=${APP_NAME} — refusing to deploy" >&2
  exit 1
fi

get_standalone_port() {
  local app="$1" ports
  ports="${APP_CFG[$app]%%;*}"
  echo "${ports%%:*}"
}

get_standby_port() {
  local app="$1" ports
  ports="${APP_CFG[$app]%%;*}"
  ports="${ports#*:}"
  echo "${ports%%:*}"
}

get_container_port() {
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

get_public_health_path() {
  # Public nginx routes for each bot — messenger uses the bare /health/ready;
  # discord/zalo use dedicated locations (see deploy/nginx/aiassist.aihubproduction.com.conf).
  case "$1" in
    discord-bot) echo "/health/discord/ready" ;;
    zalo-bot)    echo "/health/zalo/ready" ;;
    *)           echo "/health/ready" ;;
  esac
}

ensure_monitoring_network() {
  if docker network inspect "$MONITORING_NETWORK" >/dev/null 2>&1; then
    return 0
  fi
  echo "Monitoring network $MONITORING_NETWORK is missing — creating it"
  if docker network create "$MONITORING_NETWORK" >/dev/null 2>&1; then
    return 0
  fi
  if docker network inspect "$MONITORING_NETWORK" >/dev/null 2>&1; then
    return 0
  fi
  echo "ERROR: could not create monitoring network $MONITORING_NETWORK — refusing to deploy (#278)" >&2
  return 1
}

ensure_app_network() {
  if docker network inspect "$APP_NETWORK" >/dev/null 2>&1; then
    return 0
  fi
  echo "ERROR: required app network $APP_NETWORK is missing — refusing to deploy" >&2
  return 1
}

attach_app_network() {
  local container="$1"
  if docker inspect -f '{{json .NetworkSettings.Networks}}' "$container" 2>/dev/null | grep -q "\"${APP_NETWORK}\""; then
    return 0
  fi
  if ! docker network connect "$APP_NETWORK" "$container" >/dev/null 2>&1; then
    echo "ERROR: could not attach $container to app network $APP_NETWORK — refusing to deploy" >&2
    return 1
  fi
}

attach_metrics_alias() {
  local container="$1" alias="${APP_NAME}-metrics"
  docker network disconnect "$MONITORING_NETWORK" "$container" >/dev/null 2>&1 || true
  if ! docker network connect --alias "$alias" "$MONITORING_NETWORK" "$container" >/dev/null 2>&1; then
    echo "ERROR: could not attach metrics alias $alias to $container — refusing to deploy (#278)" >&2
    return 1
  fi
}

restore_metrics_alias() {
  [ -n "${ACTIVE_CONTAINER:-}" ] || return 0
  docker network connect --alias "${APP_NAME}-metrics" "$MONITORING_NETWORK" "$ACTIVE_CONTAINER" >/dev/null 2>&1 || true
}

verify_metrics_endpoint() {
  local url="$1"
  curl -sf --max-time 3 -H "Authorization: Bearer ${INTERNAL_API_KEY}" "$url" >/dev/null 2>&1
}

rollback_metrics_cutover() {
  restore_metrics_alias
  if [ "${NGINX_SWITCHED:-false}" = true ] && [ -f "$UPSTREAM_CONF" ]; then
    sed -i "s/server 127.0.0.1:[0-9]*/server 127.0.0.1:${ACTIVE_PORT}/" "$UPSTREAM_CONF"
    sudo nginx -s reload 2>/dev/null || true
  fi
  docker rm -f "$NEW_CONTAINER" >/dev/null 2>&1 || true
}

# ─── Prepare .env from production.env (Doppler download from CI) ─────────────
if [ -f "production.env" ]; then
  PRODUCTION_ENV_PRESENT=true
  if ! chmod 600 production.env; then
    echo "ERROR: could not chmod production.env to 600 — refusing to deploy" >&2
    exit 1
  fi
  DEPLOY_UID=$(id -u)
  DEPLOY_GID=$(id -g)
  ENV_INSTALL_TMP="$(mktemp "${PWD}/.env.install.XXXXXX")" || {
    echo "ERROR: could not create temporary env file — refusing to deploy" >&2
    exit 1
  }
  if ! chmod 600 "$ENV_INSTALL_TMP"; then
    echo "ERROR: could not chmod temporary env file to 600 — refusing to deploy" >&2
    exit 1
  fi
  if ! write_production_env > "$ENV_INSTALL_TMP"; then
    echo "ERROR: could not prepare production env — refusing to deploy" >&2
    exit 1
  fi
  if ! mv -f "$ENV_INSTALL_TMP" .env; then
    echo "ERROR: could not atomically install .env — refusing to deploy" >&2
    exit 1
  fi
  ENV_INSTALL_TMP=""
  echo ".env installed"
fi

# Fail closed: a container without credentials cannot boot, and the health
# check would roll it back anyway — fail early instead (#199).
if [ ! -f ".env" ]; then
  echo "ERROR: No .env file found — refusing to start a container without env (#199)" >&2
  exit 1
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

# ─── Authenticate with GHCR ──────────────────────────────────────────────────
if [ -n "${GHCR_PULL_TOKEN:-}" ] && [ -n "${GHCR_USER:-}" ]; then
  echo "$GHCR_PULL_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin 2>/dev/null || true
fi

DEPLOY_UID=${DEPLOY_UID:-$(id -u)}
DEPLOY_GID=${DEPLOY_GID:-$(id -g)}

# Reject running containers as root (#281)
if [ "$DEPLOY_UID" = "0" ]; then
  echo "ERROR: DEPLOY_UID=0 is not allowed — containers must not run as root" >&2
  exit 1
fi
# ensure_env_var wrote these into .env, but they are not shell variables yet
# ─── Prepare env file for docker run (strip quotes) ───────────────────────────
# docker run --env-file does NOT strip surrounding quotes like compose does,
# and Doppler downloads values as KEY="value" — strip them here.
# mktemp (predictable-path removal) + chmod 600 + EXIT trap: never leave
# credentials on disk after the deploy (#204).
ENV_FILE="$(mktemp "${TMPDIR:-/tmp}/${APP_NAME}.docker-env.XXXXXX")"
chmod 600 "$ENV_FILE"
trap cleanup_env_install EXIT
sed 's/^\([A-Za-z_][A-Za-z0-9_]*\)="\(.*\)"$/\1=\2/' .env > "$ENV_FILE"
# Security check (#204): refuse to run if the env file is world/group-readable.
env_mode=$(stat -c '%a' "$ENV_FILE" 2>/dev/null || echo 000)
if [ "$env_mode" != "600" ]; then
  echo "ERROR: env file $ENV_FILE has unsafe mode $env_mode (expected 600) — aborting (#204)" >&2
  exit 1
fi

INTERNAL_API_KEY=$(grep -E '^INTERNAL_API_KEY=' .env | tail -1 | cut -d= -f2- | tr -d '\r' || true)
INTERNAL_API_KEY="${INTERNAL_API_KEY%\"}"
INTERNAL_API_KEY="${INTERNAL_API_KEY#\"}"
INTERNAL_API_KEY="${INTERNAL_API_KEY%\'}"
INTERNAL_API_KEY="${INTERNAL_API_KEY#\'}"
if [ -z "$INTERNAL_API_KEY" ]; then
  echo "ERROR: INTERNAL_API_KEY is missing — refusing to verify protected metrics (#278)" >&2
  exit 1
fi

# ─── Determine active / standby ports ────────────────────────────────────────
ACTIVE_PORT=$(get_standalone_port "$APP_NAME")
STANDBY_PORT=$(get_standby_port "$APP_NAME")
CONTAINER_PORT=$(get_container_port "$APP_NAME")
UPSTREAM_CONF="${NGINX_UPSTREAM_DIR}/${APP_NAME}.conf"

# Live container: detect the port nginx currently routes to and find the
# container publishing it. Name-based fallback covers first deploy / legacy
# layout. Port-based detection is crash-safe: after an interrupted deploy the
# routed container may still be named ${APP_NAME}-new (#201).
LIVE_PORT=""
if [ -f "$UPSTREAM_CONF" ]; then
  LIVE_PORT=$(grep -oE 'server 127\.0\.0\.1:[0-9]+' "$UPSTREAM_CONF" | head -1 | grep -oE '[0-9]+$' || true)
fi
ACTIVE_CONTAINER=""
if [ -n "$LIVE_PORT" ]; then
  # publish filter takes the port only — Docker rejects "127.0.0.1:PORT".
  ACTIVE_CONTAINER=$(docker ps --filter "publish=${LIVE_PORT}" --format '{{.Names}}' | head -1 || true)
fi
if [ -z "$ACTIVE_CONTAINER" ]; then
  if docker inspect "${APP_NAME}-old" >/dev/null 2>&1; then
    ACTIVE_CONTAINER="${APP_NAME}-old"
  elif docker inspect "$APP_NAME" >/dev/null 2>&1; then
    ACTIVE_CONTAINER="$APP_NAME"
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
echo "  Active container:  ${ACTIVE_CONTAINER:-<none>} (port $ACTIVE_PORT, upstream port ${LIVE_PORT:-<none>})"
echo "  New container:     $NEW_CONTAINER (port $STANDBY_PORT)"
echo "  Image:             $IMAGE"

# Clean leftover container from a failed deploy — never remove the container
# nginx currently routes to (#201). If the live container is still named
# ${APP_NAME}-new (crash between nginx switch and rename), adopt it as
# ${APP_NAME}-old so this run deploys a fresh ${APP_NAME}-new on the other port.
if [ -n "$ACTIVE_CONTAINER" ] && [ "$ACTIVE_CONTAINER" = "$NEW_CONTAINER" ]; then
  echo "  ${NEW_CONTAINER} is the live nginx container (port ${LIVE_PORT:-?}) — adopting it as ${APP_NAME}-old"
  docker rm -f "${APP_NAME}-old" >/dev/null 2>&1 || true
  if ! docker rename "$NEW_CONTAINER" "${APP_NAME}-old" 2>/dev/null; then
    echo "ERROR: could not rename live ${NEW_CONTAINER} to ${APP_NAME}-old — aborting to protect traffic (#201)" >&2
    exit 1
  fi
  ACTIVE_CONTAINER="${APP_NAME}-old"
fi

if ! ensure_monitoring_network; then
  exit 1
fi
if ! ensure_app_network; then
  exit 1
fi
if [ -n "$ACTIVE_CONTAINER" ] && ! attach_app_network "$ACTIVE_CONTAINER"; then
  exit 1
fi
if [ -n "$ACTIVE_CONTAINER" ] && ! attach_metrics_alias "$ACTIVE_CONTAINER"; then
  exit 1
fi
docker rm -f "$NEW_CONTAINER" >/dev/null 2>&1 || true

# ─── Pull image ───────────────────────────────────────────────────────────────
# Pin by immutable digest when available (#196) — closes TOCTOU between
# manifest check and pull. Falls back to tag-only when digest is absent.
PULL_REF="$IMAGE"
if [ -n "${IMAGE_DIGEST:-}" ]; then
  PULL_REF="${IMAGE}@${IMAGE_DIGEST}"
  echo "Pinning by digest: $PULL_REF"
fi
if ! docker pull "$PULL_REF" 2>/dev/null && ! docker pull "$PULL_REF"; then
  echo "ERROR: image pull failed for $PULL_REF — refusing to deploy (#271)" >&2
  exit 1
fi

# ─── Start new container on standby port (docker run, NOT compose) ────────────
# Compose would "recreate" the old container (it matches by project/service
# labels), killing it instead of running both side by side.
echo "Starting $NEW_CONTAINER on port $STANDBY_PORT ..."

RUN_ARGS=(
  -d
  --name "$NEW_CONTAINER"
  --network "$MONITORING_NETWORK"
  --restart unless-stopped
  --user "${DEPLOY_UID}:${DEPLOY_GID}"
  --env-file "$ENV_FILE"
  --stop-timeout "${DOCKER_STOP_TIMEOUT}"    # app drain window (45s) + margin (#201)
  -e HOME=/tmp
  -e PORT="${CONTAINER_PORT}"
  -p "127.0.0.1:${STANDBY_PORT}:${CONTAINER_PORT}"
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

RUN_ARGS+=(--cap-drop ALL --security-opt no-new-privileges:true --read-only --pids-limit 256 --tmpfs /tmp:rw,noexec,nosuid,size=64m)

if ! docker run "${RUN_ARGS[@]}" "$PULL_REF"; then
  echo "ERROR: docker run failed for $NEW_CONTAINER" >&2
  docker logs "$NEW_CONTAINER" --tail 60 2>/dev/null || true
  exit 1
fi
if ! attach_app_network "$NEW_CONTAINER"; then
  docker rm -f "$NEW_CONTAINER" >/dev/null 2>&1 || true
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

echo "Checking protected metrics endpoint on standby port $STANDBY_PORT ..."
if ! verify_metrics_endpoint "http://127.0.0.1:${STANDBY_PORT}${METRICS_PATH}"; then
  echo "ERROR: New container metrics endpoint failed auth/health check — rolling back (#278)" >&2
  docker logs "$NEW_CONTAINER" --tail 80 2>/dev/null || true
  docker rm -f "$NEW_CONTAINER" >/dev/null 2>&1 || true
  exit 1
fi

# ─── Run migrations inside new container (before switching traffic) ───────────
# The advisory lock is held on the SAME psql session that runs the migration
# (#203): psql acquires the lock, executes the migration via \! (a shell escape
# inside the session, so the lock stays held), then unlocks. psql's \! swallows
# the exit status, so the migration appends it to /tmp/mig.exit which the
# outer shell checks.
if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  if [ -z "${MIGRATION_CMD:-}" ]; then
    echo "ERROR: RUN_MIGRATIONS=true requires MIGRATION_CMD — refusing to deploy (#271)" >&2
    docker rm -f "$NEW_CONTAINER" >/dev/null 2>&1 || true
    exit 1
  fi
  MIGRATION_DB_CONTAINER="${MIGRATION_DB_CONTAINER:-postgres_n8n_db}"
  MIGRATION_LOCK_ID="${MIGRATION_LOCK_ID:-4242424242}"
  DB_USER_ENV=$(grep -E '^DB_USER=' .env | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
  DB_NAME_ENV=$(grep -E '^DB_NAME=' .env | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
  DB_PASSWORD_ENV=$(grep -E '^DB_PASSWORD=' .env | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
  DB_HOST_ENV=$(grep -E '^DB_HOST=' .env | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
  DB_PORT_ENV=$(grep -E '^DB_PORT=' .env | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
  case "$MIGRATION_CMD" in
    'npx --no-install typeorm migration:run -d apps/messenger-bot/dist/infrastructure/database/data-source.js')
      ;;
    *)
      echo "ERROR: unsupported migration command" >&2
      exit 1
      ;;
  esac
  # Fail closed: never run new code against an old schema because the DB was
  # unreachable at deploy time (#199). pg_isready probes the actual postgres
  # process (a reachable container with a down postgres must still fail here,
  # before the migration and cutover). Port is 5432 — the container-internal
  # default; DB_PORT in .env is the host-mapped port and does not apply here.
  if [ -z "$DB_USER_ENV" ] || [ -z "$DB_NAME_ENV" ] || [ -z "$DB_PASSWORD_ENV" ] || [ -z "$DB_HOST_ENV" ] || ! docker exec -e PGPASSWORD="$DB_PASSWORD_ENV" "$MIGRATION_DB_CONTAINER" pg_isready -h localhost -p 5432 -U "$DB_USER_ENV" -d "$DB_NAME_ENV" >/dev/null 2>&1; then
    echo "ERROR: RUN_MIGRATIONS enabled but DB_* / postgres container ($MIGRATION_DB_CONTAINER) unavailable — refusing to deploy (#199)" >&2
    exit 1
  fi
  # Safety net: quick pg_dump before migrations
  PRE_MIGRATE_DIR="${PRE_MIGRATE_DIR:-/home/ngoc_anh/backups/ai_chat_bot_db/pre-migrate}"
  mkdir -p "$PRE_MIGRATE_DIR"
  PRE_MIGRATE_DUMP="$PRE_MIGRATE_DIR/pre-migrate-$(date +%Y%m%d-%H%M%S).dump"
  echo "Pre-migration safety dump → $PRE_MIGRATE_DUMP"
  if ! docker exec -e PGPASSWORD="$DB_PASSWORD_ENV" "$MIGRATION_DB_CONTAINER" \
    pg_dump -U "$DB_USER_ENV" -d "$DB_NAME_ENV" -h localhost -Fc \
    > "$PRE_MIGRATE_DUMP" 2>/dev/null || [ ! -s "$PRE_MIGRATE_DUMP" ]; then
    echo "ERROR: pre-migration dump failed or was empty — refusing to deploy (#271)" >&2
    rm -f "$PRE_MIGRATE_DUMP"
    docker rm -f "$NEW_CONTAINER" >/dev/null 2>&1 || true
    exit 1
  fi
  find "$PRE_MIGRATE_DIR" -name 'pre-migrate-*.dump' -mtime +1 -delete 2>/dev/null || true

  echo "Applying migrations (advisory lock $MIGRATION_LOCK_ID held on the migration session): $MIGRATION_CMD"
  if ! docker exec "$NEW_CONTAINER" sh -c "
    rm -f /tmp/mig.exit
    PGPASSWORD=\"\$DB_PASSWORD\" psql -v ON_ERROR_STOP=1 -h \"$DB_HOST_ENV\" -p \"${DB_PORT_ENV:-5432}\" -U \"$DB_USER_ENV\" -d \"$DB_NAME_ENV\" <<'SQL'
SELECT pg_advisory_lock($MIGRATION_LOCK_ID);
\\! ${MIGRATION_CMD}; echo \$? > /tmp/mig.exit
SELECT pg_advisory_unlock($MIGRATION_LOCK_ID);
SQL
    [ \"\$(cat /tmp/mig.exit 2>/dev/null)\" = \"0\" ]
  "; then
    echo "ERROR: migrations failed — rolling back" >&2
    docker rm -f "$NEW_CONTAINER" >/dev/null 2>&1 || true
    exit 1
  fi
  echo "Migrations applied OK"
  migration_status=$(docker exec "$NEW_CONTAINER" sh -c \
    'npx --no-install typeorm migration:show -d apps/messenger-bot/dist/infrastructure/database/data-source.js' 2>&1) || {
    echo "ERROR: could not verify migration status for the release image — refusing to deploy (#275)" >&2
    docker rm -f "$NEW_CONTAINER" >/dev/null 2>&1 || true
    exit 1
  }
  if printf '%s\n' "$migration_status" | grep -Eq '^[[:space:]]*\[[[:space:]]\]'; then
    echo "ERROR: release image has pending migrations — refusing to deploy (#275)" >&2
    docker rm -f "$NEW_CONTAINER" >/dev/null 2>&1 || true
    exit 1
  fi
  if [ -z "$migration_status" ] || ! printf '%s\n' "$migration_status" | grep -Eq '^[[:space:]]*\[[Xx]\]'; then
    echo "ERROR: release image migration status could not be verified — refusing to deploy (#275)" >&2
    docker rm -f "$NEW_CONTAINER" >/dev/null 2>&1 || true
    exit 1
  fi
  echo "Migration status verified for release image"
fi

# ─── Sync upstream config from upload bundle to nginx dir ─────────────────────
UPLOAD_UPSTREAM="$(pwd)/upstreams/${APP_NAME}.conf"
mkdir -p "$NGINX_UPSTREAM_DIR"
if [ -f "$UPLOAD_UPSTREAM" ]; then
  cp "$UPLOAD_UPSTREAM" "$NGINX_UPSTREAM_DIR/"
  echo "Synced upstream config → $NGINX_UPSTREAM_DIR/${APP_NAME}.conf"
fi

# ─── Switch nginx upstream to new container ───────────────────────────────────
NGINX_SWITCHED=false
if [ -f "$UPSTREAM_CONF" ]; then
  echo "Switching nginx upstream → 127.0.0.1:${STANDBY_PORT}"
  sed -i "s/server 127.0.0.1:[0-9]*/server 127.0.0.1:${STANDBY_PORT}/" "$UPSTREAM_CONF"
  if ! sudo nginx -s reload 2>/dev/null; then
    echo "ERROR: nginx reload failed — rolling back upstream" >&2
    sed -i "s/server 127.0.0.1:[0-9]*/server 127.0.0.1:${ACTIVE_PORT}/" "$UPSTREAM_CONF"
    docker rm -f "$NEW_CONTAINER" >/dev/null 2>&1 || true
    exit 1
  fi
  NGINX_SWITCHED=true
else
  if [ "${SKIP_NGINX_CHECK}" = "true" ]; then
    if [ -n "$ACTIVE_CONTAINER" ]; then
      echo "ERROR: active container $ACTIVE_CONTAINER exists — refusing to bypass nginx check (#284)" >&2
      docker rm -f "$NEW_CONTAINER" >/dev/null 2>&1 || true
      exit 1
    fi
    echo "WARNING: upstream conf not found at $UPSTREAM_CONF — SKIP_NGINX_CHECK=true, skipping nginx switch (first-deploy bootstrap)"
  else
    echo "ERROR: upstream conf not found at $UPSTREAM_CONF — refusing to cut over without nginx (#199)" >&2
    docker rm -f "$NEW_CONTAINER" >/dev/null 2>&1 || true
    exit 1
  fi
fi

# ─── Move the stable metrics alias to the active container ───────────────────
# Keep the old alias until nginx has switched, then accept only a short DNS
# scrape gap while the alias is moved. This avoids Prometheus randomly
# resolving both blue-green containers during the cutover (#278).
if [ -n "$ACTIVE_CONTAINER" ] && ! docker network disconnect "$MONITORING_NETWORK" "$ACTIVE_CONTAINER" >/dev/null 2>&1; then
  echo "ERROR: could not detach metrics alias from $ACTIVE_CONTAINER — rolling back (#278)" >&2
  rollback_metrics_cutover
  exit 1
fi
if ! attach_metrics_alias "$NEW_CONTAINER"; then
  echo "ERROR: could not attach metrics alias to $NEW_CONTAINER — rolling back (#278)" >&2
  rollback_metrics_cutover
  exit 1
fi

NEW_CONTAINER_IP=$(docker inspect -f "{{(index .NetworkSettings.Networks \"${MONITORING_NETWORK}\").IPAddress}}" "$NEW_CONTAINER" 2>/dev/null || true)
if [ -z "$NEW_CONTAINER_IP" ] || ! verify_metrics_endpoint "http://${NEW_CONTAINER_IP}:${CONTAINER_PORT}${METRICS_PATH}"; then
  echo "ERROR: metrics endpoint is not reachable through $MONITORING_NETWORK — rolling back (#278)" >&2
  rollback_metrics_cutover
  exit 1
fi

# ─── Post-switch health monitor (2 minutes) ──────────────────────────────────
# Verify the public nginx route (not only the standby port) once the switch
# happened (#199); curl --resolve pins the public host to 127.0.0.1 so the
# check never depends on hairpin NAT from the VPS to its own public IP.
PUBLIC_HEALTH_PATH=$(get_public_health_path "$APP_NAME")
echo "Monitoring health on $([ "$NGINX_SWITCHED" = "true" ] && echo "public route https://${PUBLIC_HOST}${PUBLIC_HEALTH_PATH}" || echo "port $STANDBY_PORT$HEALTH_PATH") for $(( POST_SWITCH_MONITOR_ATTEMPTS * POST_SWITCH_MONITOR_INTERVAL ))s ..."
monitor_healthy=""
monitor_failures=0
MONITOR_MAX_FAILURES="${MONITOR_MAX_FAILURES:-3}"
check_post_switch_health() {
  if [ "$NGINX_SWITCHED" = "true" ]; then
    curl -sf --max-time 3 --resolve "${PUBLIC_HOST}:443:127.0.0.1" "https://${PUBLIC_HOST}${PUBLIC_HEALTH_PATH}"
  else
    curl -sf --max-time 3 "http://127.0.0.1:${STANDBY_PORT}${HEALTH_PATH}"
  fi
}
for attempt in $(seq 1 "${POST_SWITCH_MONITOR_ATTEMPTS}"); do
  if check_post_switch_health >/dev/null 2>&1; then
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
  rollback_metrics_cutover
  exit 1
fi

echo "Post-switch health OK — new container stable"

# ─── Stop old container ──────────────────────────────────────────────────────
if [ -n "$ACTIVE_CONTAINER" ] && [ -n "$ACTIVE_CONTAINER_IMAGE" ]; then
  echo "Stopping old container: $ACTIVE_CONTAINER"
  docker stop --timeout "${DOCKER_STOP_TIMEOUT}" "$ACTIVE_CONTAINER" 2>/dev/null || true
  docker rm "$ACTIVE_CONTAINER" 2>/dev/null || true
fi

# ─── Rename new container → old (for next deploy) ────────────────────────────
if docker inspect "$NEW_CONTAINER" >/dev/null 2>&1; then
  docker rename "$NEW_CONTAINER" "${APP_NAME}-old" 2>/dev/null || true
fi

echo "✓ Deploy complete: $APP_NAME ($IMAGE) on port $STANDBY_PORT"
