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
: "${IMAGE:?IMAGE is required}"
: "${DEPLOY_MODE:?DEPLOY_MODE is required}"

mkdir -p -m 700 "$HOME/.ssh"
echo "$SSH_PRIVATE_KEY" > "$HOME/.ssh/id_ed25519"
chmod 600 "$HOME/.ssh/id_ed25519"
printf '%s\n' "$VPS_KNOWN_HOSTS" > "$HOME/.ssh/known_hosts"
chmod 600 "$HOME/.ssh/known_hosts"

ssh -p "$VPS_SSH_PORT" \
  -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="$HOME/.ssh/known_hosts" \
  -o ServerAliveInterval=30 \
  "${VPS_USER}@${VPS_HOST}" \
  "export IMAGE='$IMAGE' DEPLOY_MODE='$DEPLOY_MODE' FORCE_RECREATE='$FORCE_RECREATE' GHCR_PULL_TOKEN='$GHCR_PULL_TOKEN' GHCR_USER='$GHCR_USER' APP_NAME='${APP_NAME:-}' HEALTH_PATH='${HEALTH_PATH:-}' PORT='${PORT:-}' RUN_MIGRATIONS='${RUN_MIGRATIONS:-}' MIGRATION_CMD='${MIGRATION_CMD:-}' NGINX_UPSTREAM_DIR='${NGINX_UPSTREAM_DIR:-}' && cd '$(dirname "$REMOTE_SCRIPT")' && exec bash '$(basename "$REMOTE_SCRIPT")'" \
  < /dev/null
