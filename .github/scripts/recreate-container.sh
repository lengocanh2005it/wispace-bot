#!/usr/bin/env bash
set -euo pipefail

# Recreate a container with the SAME config (name, ports, mounts, groups,
# resources, env) but a fresh image + current .env. Used by Doppler runtime
# sync to restart a bot after its env changed on Doppler.
#
# Usage: recreate-container.sh <container-name> <image>
# Optional env: HEALTH_PATH (default /health), HEALTH_TIMEOUT (default 60s).
# Runs on the VPS host (or a docker-cli sidecar) with docker.sock mounted.

NAME="${1:?container name required}"
IMAGE="${2:?image required}"

# Capture config BEFORE removing the container
CFG_USER=$(docker inspect "$NAME" --format '{{.Config.User}}' 2>/dev/null || true)
CFG_MEM=$(docker inspect "$NAME" --format '{{.HostConfig.Memory}}' 2>/dev/null || true)
CFG_CPU=$(docker inspect "$NAME" --format '{{.HostConfig.NanoCpus}}' 2>/dev/null || true)
CFG_RESTART=$(docker inspect "$NAME" --format '{{.HostConfig.RestartPolicy.Name}}' 2>/dev/null || true)
CFG_GID=$(docker inspect "$NAME" --format '{{range .HostConfig.GroupAdd}}{{.}} {{end}}' 2>/dev/null || true)
CFG_MOUNTS=$(docker inspect "$NAME" --format '{{range .Mounts}}{{.Source}}:{{.Destination}}{{if not .RW}}:ro{{end}};{{end}}' 2>/dev/null || true)
CFG_PORTS=$(docker inspect "$NAME" --format '{{range $p, $c := .NetworkSettings.Ports}}{{if $c}}{{range $c}}{{.HostIp}}:{{.HostPort}}:{{$p}} {{end}}{{end}}{{end}}' 2>/dev/null || true)
CFG_ENV_FILE=$(docker inspect "$NAME" --format '{{range .Mounts}}{{if eq .Destination "/deploy/.env"}}{{.Source}}{{end}}{{end}}' 2>/dev/null || true)

if [ -z "$CFG_MOUNTS" ] && [ -z "$CFG_PORTS" ]; then
  echo "ERROR: container $NAME not found" >&2
  exit 1
fi

# Env file for docker run: strip quotes (docker run --env-file does not)
ENV_TMP=$(mktemp)
trap 'rm -f "$ENV_TMP"' EXIT
if [ -n "$CFG_ENV_FILE" ] && [ -f "$CFG_ENV_FILE" ]; then
  sed 's/^\([A-Za-z_][A-Za-z0-9_]*\)="\(.*\)"$/\1=\2/' "$CFG_ENV_FILE" > "$ENV_TMP"
fi

# Current host port (e.g. 127.0.0.1:5007:5007/tcp -> 5007)
CFG_PORT=$(echo "$CFG_PORTS" | awk '{print $1}' | cut -d: -f2)

# Keep the old container around until the replacement is healthy — a bad env
# sync must not take the bot down with no recovery.
BACKUP_NAME="${NAME}-old"
docker rename "$NAME" "$BACKUP_NAME" >/dev/null 2>&1 || true

args=(-d --name "$NAME" --restart "${CFG_RESTART:-unless-stopped}")
[ -n "$CFG_USER" ] && args+=(--user "$CFG_USER")
[ -n "$CFG_MEM" ] && [ "$CFG_MEM" != "0" ] && args+=(--memory "$CFG_MEM")
if [ -n "$CFG_CPU" ] && [ "$CFG_CPU" != "0" ]; then
  args+=(--cpus "$(awk "BEGIN{printf \"%.2f\", $CFG_CPU/1000000000}")")
fi
IFS=';' read -r -a MO <<< "$CFG_MOUNTS"
for m in "${MO[@]}"; do
  [ -n "$m" ] && args+=(-v "$m")
done
for p in $CFG_PORTS; do
  # strip /tcp suffix: 127.0.0.1:5008:5008/tcp -> -p 127.0.0.1:5008:5008
  [ -n "$p" ] && args+=(-p "${p%/tcp}")
done
for g in $CFG_GID; do
  [ -n "$g" ] && args+=(--group-add "$g")
done
if [ -s "$ENV_TMP" ]; then
  args+=(--env-file "$ENV_TMP")
fi
[ -n "$CFG_PORT" ] && args+=(-e PORT="$CFG_PORT")
args+=(-e HOME=/tmp)

args+=("$IMAGE")

docker run "${args[@]}"

# Health gate: wait for /health (default path, overridable) before dropping
# the old container. On failure, roll back to the previous container.
# Runs via `docker exec node -e fetch(...)` INSIDE the new container — the
# sidecar image (docker:29-cli) has no curl, but the bot image is node-based.
HEALTH_PATH="${HEALTH_PATH:-/health}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-60}"
health_ok=""
for attempt in $(seq 1 "$HEALTH_TIMEOUT"); do
  if docker exec "$NAME" node -e "fetch('http://127.0.0.1:${CFG_PORT}${HEALTH_PATH}').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" >/dev/null 2>&1; then
    health_ok=1
    break
  fi
  sleep 1
done

if [ -n "$health_ok" ]; then
  docker rm -f "$BACKUP_NAME" >/dev/null 2>&1 || true
  echo "Container $NAME healthy — old container removed"
else
  echo "ERROR: new container $NAME failed health check — rolling back" >&2
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker rename "$BACKUP_NAME" "$NAME" >/dev/null 2>&1 || true
  docker start "$NAME" >/dev/null 2>&1 || true
  exit 1
fi
