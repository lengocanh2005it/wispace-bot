#!/usr/bin/env bash
set -euo pipefail

# Run a deploy script on the VPS via SSH
# Usage: bash .github/scripts/ssh-deploy-vps.sh <remote-script-path>
# Requires: SSH_PRIVATE_KEY, VPS_HOST, VPS_USER, IMAGE, DEPLOY_MODE

REMOTE_SCRIPT="${1:?remote script path is required}"
: "${SSH_PRIVATE_KEY:?SSH_PRIVATE_KEY is required}"
: "${VPS_HOST:?VPS_HOST is required}"
: "${VPS_USER:?VPS_USER is required}"
: "${IMAGE:?IMAGE is required}"
: "${DEPLOY_MODE:?DEPLOY_MODE is required}"
: "${VPS_SSH_PORT:=22}"

mkdir -p -m 700 "$HOME/.ssh"
echo "$SSH_PRIVATE_KEY" > "$HOME/.ssh/id_ed25519"
chmod 600 "$HOME/.ssh/id_ed25519"

ssh -p "$VPS_SSH_PORT" \
  -o StrictHostKeyChecking=no \
  -o ServerAliveInterval=30 \
  "${VPS_USER}@${VPS_HOST}" \
  "cd '$(dirname "$REMOTE_SCRIPT")' && exec bash '$(basename "$REMOTE_SCRIPT")'" \
  < /dev/null
