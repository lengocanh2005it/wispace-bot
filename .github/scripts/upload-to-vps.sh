#!/usr/bin/env bash
# shellcheck disable=SC2015
set -euo pipefail

# Upload a bundle directory to VPS via rsync over SSH
# Usage: bash .github/scripts/upload-to-vps.sh <source-dir>
# Requires: SSH_PRIVATE_KEY, VPS_HOST, VPS_USER, VPS_TARGET_DIR

SOURCE_DIR="${1:?source directory is required}"
: "${SSH_PRIVATE_KEY:?SSH_PRIVATE_KEY is required}"
: "${VPS_HOST:?VPS_HOST is required}"
: "${VPS_USER:?VPS_USER is required}"
: "${VPS_TARGET_DIR:?VPS_TARGET_DIR is required}"
: "${VPS_KNOWN_HOSTS:?VPS_KNOWN_HOSTS is required}"

mkdir -p -m 700 "$HOME/.ssh"
echo "$SSH_PRIVATE_KEY" > "$HOME/.ssh/id_ed25519"
chmod 600 "$HOME/.ssh/id_ed25519"
printf '%s\n' "$VPS_KNOWN_HOSTS" > "$HOME/.ssh/known_hosts"
chmod 600 "$HOME/.ssh/known_hosts"

# Exponential backoff: the VPS provider (Hostinger) rate-limits new SSH
# connections from GitHub runner IPs and drops them for a few minutes.
# Retry long enough (8 attempts, ~8 min) to ride through the block.
# --exclude .env: the live Vault bootstrap remains in place until the deploy
# script atomically installs the new bootstrap file (#654).
attempt=1
while [ "$attempt" -le 8 ]; do
  if rsync -avz --delete --exclude '.env' \
    -e "ssh -p $VPS_SSH_PORT -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$HOME/.ssh/known_hosts -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=3" \
    "$SOURCE_DIR/" \
    "${VPS_USER}@${VPS_HOST}:${VPS_TARGET_DIR}/"; then
    exit 0
  fi
  if [ "$attempt" -lt 8 ]; then
    wait_seconds=$((attempt * 15))
    echo "Upload attempt $attempt failed, retrying in ${wait_seconds}s..."
    sleep "$wait_seconds"
  fi
  attempt=$((attempt + 1))
done

echo "ERROR: upload failed after 8 attempts" >&2
exit 1
