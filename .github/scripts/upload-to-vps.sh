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
: "${VPS_SSH_PORT:=22}"

mkdir -p -m 700 "$HOME/.ssh"
echo "$SSH_PRIVATE_KEY" > "$HOME/.ssh/id_ed25519"
chmod 600 "$HOME/.ssh/id_ed25519"
ssh-keyscan -p "$VPS_SSH_PORT" "$VPS_HOST" >> "$HOME/.ssh/known_hosts" 2>/dev/null

for i in 1 2 3; do
  if rsync -avz --delete \
    -e "ssh -p $VPS_SSH_PORT -o StrictHostKeyChecking=no" \
    "$SOURCE_DIR/" \
    "${VPS_USER}@${VPS_HOST}:${VPS_TARGET_DIR}/"; then
    exit 0
  fi
  echo "Upload attempt $i failed, retrying in 5s..."
  sleep 5
done

echo "ERROR: upload failed after 3 attempts" >&2
exit 1
