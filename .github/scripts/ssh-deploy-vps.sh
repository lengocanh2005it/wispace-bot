#!/usr/bin/env bash
set -euo pipefail

# Run a deploy script on the VPS via SSH
# Usage: bash .github/scripts/ssh-deploy-vps.sh <remote-script-path>
# Requires: SSH_PRIVATE_KEY, VPS_HOST, VPS_USER, IMAGE, DEPLOY_MODE

REMOTE_SCRIPT="${1:?remote script path is required}"
: "${SSH_PRIVATE_KEY:?SSH_PRIVATE_KEY is required}"
: "${VPS_HOST:?VPS_HOST is required}"
: "${VPS_USER:?VPS_USER is required}"
: "${VPS_KNOWN_HOSTS:?VPS_KNOWN_HOSTS is required}"
: "${VPS_TARGET_DIR:?VPS_TARGET_DIR is required}"
: "${IMAGE:?IMAGE is required}"
: "${DEPLOY_MODE:?DEPLOY_MODE is required}"

die() {
  echo "ERROR: $1" >&2
  exit 1
}

case "$VPS_TARGET_DIR" in
  /*) ;;
  *) die "VPS_TARGET_DIR must be an absolute path" ;;
esac

case "$REMOTE_SCRIPT" in
  /*) ;;
  *) die "REMOTE_SCRIPT must be an absolute path" ;;
esac

case "$REMOTE_SCRIPT" in
  "$VPS_TARGET_DIR"/*) ;;
  *) die "REMOTE_SCRIPT must be under VPS_TARGET_DIR" ;;
esac

case "$REMOTE_SCRIPT" in
  *$'\n'*|*$'\r'*|*';'*|*'`'*|*\$\(*|*'../'*|*/'..')
    die "REMOTE_SCRIPT contains an unsafe path"
    ;;
esac

shell_quote() {
  local value="$1"
  value=${value//\'/\'\\\'\'}
  printf "'%s'" "$value"
}

REMOTE_WRAPPER='set -euo pipefail
umask 077
payload_file=$(mktemp)
cleanup() { rm -f "$payload_file"; }
trap cleanup EXIT
chmod 600 "$payload_file"
cat > "$payload_file"
. "$payload_file"
rm -f "$payload_file"
exec bash "$1" </dev/null
'
REMOTE_COMMAND="bash -c $(shell_quote "$REMOTE_WRAPPER") -- $(shell_quote "$REMOTE_SCRIPT")"

DEPLOY_VARIABLES=(
  IMAGE DEPLOY_MODE FORCE_RECREATE GHCR_PULL_TOKEN GHCR_USER APP_NAME
  HEALTH_PATH PORT RUN_MIGRATIONS MIGRATION_CMD MIGRATION_PREFLIGHT_CMD
  MIGRATION_STATUS_CMD NGINX_UPSTREAM_DIR
)

send_payload() {
  local name
  for name in "${DEPLOY_VARIABLES[@]}"; do
    printf 'export %s=%q\n' "$name" "${!name-}"
  done | ssh -p "$VPS_SSH_PORT" \
    -o StrictHostKeyChecking=yes \
    -o UserKnownHostsFile="$HOME/.ssh/known_hosts" \
    -o ServerAliveInterval=30 \
    -o ConnectTimeout=30 \
    "${VPS_USER}@${VPS_HOST}" \
    "$REMOTE_COMMAND"
}

mkdir -p -m 700 "$HOME/.ssh"
echo "$SSH_PRIVATE_KEY" > "$HOME/.ssh/id_ed25519"
chmod 600 "$HOME/.ssh/id_ed25519"
printf '%s\n' "$VPS_KNOWN_HOSTS" > "$HOME/.ssh/known_hosts"
chmod 600 "$HOME/.ssh/known_hosts"

# Retry the SSH session: the VPS provider rate-limits new SSH connections
# from runner IPs (drops them for a few minutes). 4 attempts with long
# backoff rides through the block — the deploy script itself is idempotent
# enough to re-run safely (container names are cleaned before start).
attempt=1
while [ "$attempt" -le 4 ]; do
  if send_payload; then
    exit 0
  fi
  if [ "$attempt" -lt 4 ]; then
    wait_seconds=$((attempt * 20))
    echo "SSH deploy attempt $attempt failed, retrying in ${wait_seconds}s..."
    sleep "$wait_seconds"
  fi
  attempt=$((attempt + 1))
done

echo "ERROR: SSH deploy failed after 4 attempts" >&2
exit 1
