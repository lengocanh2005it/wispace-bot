#!/usr/bin/env bash
set -euo pipefail

# Offsite replication of the encrypted PostgreSQL backup artifacts (#866,
# parent #273). Runs after the nightly backup (separate cron so a network
# failure never corrupts the local backup state).
#
# Uploads to an S3-compatible bucket (B2/R2/S3) via rclone: the latest dump,
# its globals capture, and the newest restore-verify evidence JSON. Uploads
# are atomic — copied to a temp name, verified against a local sha256
# sidecar, then promoted (moveto) to the final object name. Remote deletion
# is never performed here; retention belongs to the bucket lifecycle rule and
# versioning protects against remote deletion/ransomware.
#
# Credentials: OFFSITE_S3_* + BACKUP_ENCRYPTION_PASSPHRASE come from the same
# Vault-only env file as the backup (never argv, never logged).
#
# Install (cron, ~03:30 ICT after the 02:00 backup):
#   cp deploy/postgres-offsite-sync.sh /home/ngoc_anh/scripts/
#   chmod +x /home/ngoc_anh/scripts/postgres-offsite-sync.sh
#   30 3 * * * /home/ngoc_anh/scripts/postgres-offsite-sync.sh \
#     >> /home/ngoc_anh/backups/offsite-sync.log 2>&1

usage() {
  cat >&2 <<'USAGE'
Usage: postgres-offsite-sync.sh --backup-dir DIR --env-file ENV_FILE [--self-check]
Env: OFFSITE_S3_ENDPOINT, OFFSITE_S3_BUCKET, OFFSITE_S3_ACCESS_KEY,
     OFFSITE_S3_SECRET_KEY (all required), OFFSITE_S3_REGION (optional)
USAGE
  exit 2
}

die() { echo "ERROR: $1" >&2; exit 1; }
log() { echo "[offsite-sync] $1"; }

BACKUP_DIR=""
ENV_FILE=""
SELF_CHECK=0

while [ $# -gt 0 ]; do
  case "$1" in
    --backup-dir) BACKUP_DIR="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --self-check) SELF_CHECK=1; shift ;;
    *) usage ;;
  esac
done

[ -n "$BACKUP_DIR" ] || usage
[ -n "$ENV_FILE" ] || usage

env_value() { # NAME FILE
  grep -E "^$1=" "$2" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true
}

ALERTMANAGER_URL="${ALERTMANAGER_URL:-http://127.0.0.1:9093}"
OFFSITE_ALERT="postgres_offsite_failed"
SUCCESS_MARKER="$BACKUP_DIR/.last-offsite-success"

post_alert() { # alertname annotations_json [ends_at]
  local alertname="$1"
  local body="[{\"labels\":{\"alertname\":\"$alertname\",\"severity\":\"critical\"},\"annotations\":$2"
  if [ -n "${3:-}" ]; then body="$body,\"endsAt\":\"$3\""; fi
  body="$body}]"
  curl -sf -X POST "$ALERTMANAGER_URL/api/v2/alerts" \
    -H 'Content-Type: application/json' \
    -d "$body" \
    >/dev/null 2>&1 || echo "WARN [$(date -Is)] Alertmanager notify failed (curl)" >&2
}

resolve_alert() {
  post_alert "$OFFSITE_ALERT" "{}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

command -v rclone >/dev/null || die "rclone is required"
command -v sha256sum >/dev/null || die "sha256sum is required"

[ -f "$ENV_FILE" ] || die "missing env file: $ENV_FILE"

ENDPOINT=$(env_value OFFSITE_S3_ENDPOINT "$ENV_FILE")
BUCKET=$(env_value OFFSITE_S3_BUCKET "$ENV_FILE")
ACCESS_KEY=$(env_value OFFSITE_S3_ACCESS_KEY "$ENV_FILE")
SECRET_KEY=$(env_value OFFSITE_S3_SECRET_KEY "$ENV_FILE")
REGION=$(env_value OFFSITE_S3_REGION "$ENV_FILE")

for var in ENDPOINT BUCKET ACCESS_KEY SECRET_KEY; do
  [ -n "${!var}" ] || die "missing OFFSITE_S3_* credentials in $ENV_FILE (OFFSITE_S3_${var#OFFSITE_S3_})"
done

# rclone config from env — a mode-600 temp file, never argv flags.
RCLONE_CONF=$(mktemp "${TMPDIR:-/tmp}/offsite-rclone.XXXXXX")
trap 'rm -f "$RCLONE_CONF"' EXIT INT TERM
{
  echo "[offsite]"
  echo "type = s3"
  echo "provider = Other"
  echo "endpoint = $ENDPOINT"
  [ -n "$REGION" ] && echo "region = $REGION"
} > "$RCLONE_CONF"

RCLONE() { # <rclone args...>
  RCLONE_CONFIG="$RCLONE_CONF" RCLONE_CONFIG_OFFSITE_TYPE=s3 \
    RCLONE_CONFIG_OFFSITE_ENDPOINT="$ENDPOINT" \
    RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID="$ACCESS_KEY" \
    RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY="$SECRET_KEY" \
    rclone "$@"
}

REMOTE="offsite:$BUCKET"
REMOTE_LATEST="$REMOTE/latest"

# --- Self-check: fresh-host bootstrap validation (no upload) -------------------
if [ "$SELF_CHECK" -eq 1 ]; then
  RCLONE lsl "$REMOTE" >/dev/null \
    || die "self-check failed: cannot list $REMOTE (bad credentials/endpoint/bucket?)"
  log "self-check OK — credentials and bucket reachable"
  exit 0
fi

# --- Local artifact selection: latest pair + newest evidence -------------------
LATEST_DUMP=$(ls -1t "$BACKUP_DIR"/*.sql.gz.gpg 2>/dev/null | grep -v globals | head -1 || true)
[ -n "$LATEST_DUMP" ] || { post_alert "$OFFSITE_ALERT" \
  "{\"summary\":\"Offsite sync failed\",\"description\":\"No local dump artifact in $BACKUP_DIR\"}"; \
  die "no local dump artifacts found in $BACKUP_DIR"; }

STAMP=$(basename "$LATEST_DUMP")
STAMP=${STAMP#"$BACKUP_DIR"/}
DB_PREFIX=${STAMP%%.sql.gz.gpg}
LATEST_GLOBALS="$BACKUP_DIR/${DB_PREFIX}.globals.sql.gz.gpg"
[ -f "$LATEST_GLOBALS" ] \
  || die "missing paired globals artifact for $(basename "$LATEST_DUMP") (#865 contract)"

LATEST_EVIDENCE=$(ls -1t "$EVIDENCE_DIR"/restore-verify-*.json 2>/dev/null | head -1 || true)
EVIDENCE_DIR="${EVIDENCE_DIR:-$BACKUP_DIR/restore-verify}"
[ -d "$EVIDENCE_DIR" ] && LATEST_EVIDENCE=$(ls -1t "$EVIDENCE_DIR"/restore-verify-*.json 2>/dev/null | head -1 || true)

# Fail-closed alert: any failure after local validation fires the offsite
# alert (bounded — resolved by the next successful run).
sync_fail() {
  post_alert "$OFFSITE_ALERT" \
    "{\"summary\":\"Offsite backup sync failed\",\"description\":\"$1\"}"
  die "$1"
}

sync_artifact() { # src remote-dest name
  local src="$1" dest="$2" name="$3"
  local sha remote_sha
  sha=$(sha256sum "$src" | cut -d' ' -f1)
  printf '%s  %s\n' "$sha" "$name" > "$src.sha256"
  # Atomic: copy to a temp name, verify the transferred bytes, then promote.
  RCLONE copyto "$src" "$dest.uploading" \
    || sync_fail "rclone upload failed for $name"
  remote_sha=$(RCLONE cat "$dest.uploading" | sha256sum | cut -d' ' -f1)
  [ "$remote_sha" = "$sha" ] \
    || sync_fail "post-transfer checksum mismatch for $name (local=$sha remote=$remote_sha)"
  RCLONE moveto "$dest.uploading" "$dest" \
    || sync_fail "rclone promote (moveto) failed for $name"
  RCLONE copyto "$src.sha256" "$dest.sha256" \
    || sync_fail "rclone sidecar upload failed for $name.sha256"
}

sync_artifact "$LATEST_DUMP" "$REMOTE_LATEST/$(basename "$LATEST_DUMP")" "$(basename "$LATEST_DUMP")"
sync_artifact "$LATEST_GLOBALS" "$REMOTE_LATEST/$(basename "$LATEST_GLOBALS")" "$(basename "$LATEST_GLOBALS")"
if [ -n "$LATEST_EVIDENCE" ]; then
  RCLONE copyto "$LATEST_EVIDENCE" "$REMOTE_LATEST/$(basename "$LATEST_EVIDENCE")" \
    || die "rclone evidence upload failed"
fi

date +%s > "$SUCCESS_MARKER"
resolve_alert
log "offsite sync OK — $(basename "$LATEST_DUMP") + globals + evidence promoted to $REMOTE_LATEST"