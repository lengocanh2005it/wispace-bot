#!/usr/bin/env bash
set -euo pipefail

# Offsite replication of the encrypted PostgreSQL backup artifacts (#866,
# parent #273). Runs after the nightly backup (separate cron so a network
# failure never corrupts the local backup state).
#
# Uploads to an S3-compatible bucket (B2/R2/S3) via rclone: the latest dump,
# its globals capture, newest encrypted pre-migration dump, and newest
# restore-verify evidence JSON. Uploads
# are atomic — copied to a temp name, verified against a local sha256
# sidecar, then promoted (moveto) to the final object name. Remote deletion
# is never performed here; retention belongs to the bucket lifecycle rule and
# versioning protects against remote deletion/ransomware.
#
# Credentials: OFFSITE_S3_* come from the host-only Vault-rendered backup env
# (never argv, never logged).
#
# Install (cron, ~03:30 ICT after the 02:00 backup):
#   cp deploy/postgres-offsite-sync.sh /home/ngoc_anh/scripts/
#   chmod +x /home/ngoc_anh/scripts/postgres-offsite-sync.sh
#   30 3 * * * /home/ngoc_anh/scripts/postgres-offsite-sync.sh \
#     --backup-dir /home/ngoc_anh/backups/ai_chat_bot_db \
#     --env-file /home/ngoc_anh/backups/ai_chat_bot_db/backup.env \
#     >> /home/ngoc_anh/backups/offsite-sync.log 2>&1

# Immediate startup banner so executions always leave an observable signal (#1325).
echo "[$(date -Is)] [postgres-offsite-sync] Starting PostgreSQL offsite sync..."

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
  grep -E "^$1=" "$2" 2>/dev/null | tail -1 | cut -d= -f2- | sed -e 's/^["'"'"']//' -e 's/["'"'"']$//' || true
}

json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

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

sync_fail() {
  local message="$1"
  local escaped
  escaped=$(json_escape "$message")
  post_alert "$OFFSITE_ALERT" \
    "{\"summary\":\"Offsite backup sync failed\",\"description\":\"$escaped\"}"
  die "$message"
}

on_error() {
  local exit_code="$1" line="$2"
  echo "ERROR [$(date -Is)]: postgres-offsite-sync failed at line $line with exit code $exit_code" >&2
  local escaped
  escaped=$(json_escape "Script error at line $line with exit code $exit_code")
  post_alert "$OFFSITE_ALERT" "{\"summary\":\"Offsite backup sync failed\",\"description\":\"$escaped\"}" 2>/dev/null || true
}
trap 'on_error $? $LINENO' ERR

command -v rclone >/dev/null || sync_fail "rclone is required"
command -v sha256sum >/dev/null || sync_fail "sha256sum is required"
command -v curl >/dev/null || die "curl is required for alert delivery"

[ -f "$ENV_FILE" ] || sync_fail "missing env file: $ENV_FILE"

ENDPOINT=$(env_value OFFSITE_S3_ENDPOINT "$ENV_FILE")
BUCKET=$(env_value OFFSITE_S3_BUCKET "$ENV_FILE")
ACCESS_KEY=$(env_value OFFSITE_S3_ACCESS_KEY "$ENV_FILE")
SECRET_KEY=$(env_value OFFSITE_S3_SECRET_KEY "$ENV_FILE")
REGION=$(env_value OFFSITE_S3_REGION "$ENV_FILE")

for var in ENDPOINT BUCKET ACCESS_KEY SECRET_KEY; do
  [ -n "${!var}" ] || sync_fail "missing OFFSITE_S3_* credentials in $ENV_FILE (OFFSITE_S3_${var#OFFSITE_S3_})"
done

# rclone config from env — a mode-600 temp file, never argv flags.
RCLONE_CONF=""
WORK_DIR=""
cleanup() {
  [ -z "$WORK_DIR" ] || rm -rf "$WORK_DIR"
  [ -z "$RCLONE_CONF" ] || rm -f "$RCLONE_CONF"
}
trap cleanup EXIT
trap 'cleanup; exit 143' INT TERM

RCLONE_CONF=$(mktemp "${TMPDIR:-/tmp}/offsite-rclone.XXXXXX") \
  || sync_fail "could not create temporary rclone config"
WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/offsite-sync.XXXXXX") \
  || sync_fail "could not create temporary work directory"
chmod 600 "$RCLONE_CONF" || sync_fail "could not chmod temporary rclone config"
if ! {
  echo "[offsite]"
  echo "type = s3"
  echo "provider = Other"
  echo "endpoint = $ENDPOINT"
  if [ -n "$REGION" ]; then
    echo "region = $REGION"
  fi
} > "$RCLONE_CONF"; then
  sync_fail "could not write temporary rclone config"
fi

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
    || sync_fail "self-check failed: cannot list $REMOTE (bad credentials/endpoint/bucket?)"
  log "self-check OK — credentials and bucket reachable"
  exit 0
fi

# --- Local artifact selection: latest validated pair + newest evidence --------
BACKUP_MARKER="$BACKUP_DIR/.last-backup-success"
[ -f "$BACKUP_MARKER" ] || sync_fail "No local backup success marker in $BACKUP_DIR"
BACKUP_MARKER_VALUE=$(cat "$BACKUP_MARKER")
printf '%s' "$BACKUP_MARKER_VALUE" | grep -Eq '^[0-9]+$' \
  || sync_fail "Local backup success marker is invalid in $BACKUP_DIR"

EVIDENCE_DIR="${EVIDENCE_DIR:-$BACKUP_DIR/restore-verify}"
LATEST_DUMP=$(ls -1t "$BACKUP_DIR"/*.sql.gz.gpg 2>/dev/null | grep -v globals | head -1 || true)
[ -n "$LATEST_DUMP" ] || sync_fail "No local dump artifact in $BACKUP_DIR"
[ -s "$LATEST_DUMP" ] || sync_fail "Local dump artifact is empty: $(basename "$LATEST_DUMP")"

STAMP=$(basename "$LATEST_DUMP")
STAMP=${STAMP#"$BACKUP_DIR"/}
DB_PREFIX=${STAMP%%.sql.gz.gpg}
LATEST_GLOBALS="$BACKUP_DIR/${DB_PREFIX}.globals.sql.gz.gpg"
[ -s "$LATEST_GLOBALS" ] \
  || sync_fail "Missing paired globals artifact for $(basename "$LATEST_DUMP") (#865 contract)"
LATEST_STATE="$BACKUP_DIR/${DB_PREFIX}.state.json.gz.gpg"
[ -s "$LATEST_STATE" ] \
  || sync_fail "Missing state sidecar for $(basename "$LATEST_DUMP") (#879 contract)"

LATEST_EVIDENCE=""
[ -d "$EVIDENCE_DIR" ] && LATEST_EVIDENCE=$(ls -1t "$EVIDENCE_DIR"/restore-verify-*.json 2>/dev/null | head -1 || true)
PRE_MIGRATE_DIR="${PRE_MIGRATE_DIR:-$BACKUP_DIR/pre-migrate}"
LATEST_PRE_MIGRATE=""
[ -d "$PRE_MIGRATE_DIR" ] && LATEST_PRE_MIGRATE=$(ls -1t "$PRE_MIGRATE_DIR"/pre-migrate-*.dump.gpg 2>/dev/null | head -1 || true)

DUMP_NAME=$(basename "$LATEST_DUMP")
GLOBALS_NAME=$(basename "$LATEST_GLOBALS")
STATE_NAME=$(basename "$LATEST_STATE")
DUMP_SHA=$(sha256sum "$LATEST_DUMP" | cut -d' ' -f1)
GLOBALS_SHA=$(sha256sum "$LATEST_GLOBALS" | cut -d' ' -f1)
STATE_SHA=$(sha256sum "$LATEST_STATE" | cut -d' ' -f1)
DUMP_SIZE=$(wc -c < "$LATEST_DUMP" | tr -d '[:space:]')
GLOBALS_SIZE=$(wc -c < "$LATEST_GLOBALS" | tr -d '[:space:]')
STATE_SIZE=$(wc -c < "$LATEST_STATE" | tr -d '[:space:]')
MANIFEST_TMP="$WORK_DIR/manifest.tsv"

sync_artifact() { # src remote-dest name
  local src="$1" dest="$2" name="$3"
  local sha remote_sha sidecar
  sha=$(sha256sum "$src" | cut -d' ' -f1)
  sidecar="$WORK_DIR/$name.sha256"
  printf '%s  %s\n' "$sha" "$name" > "$sidecar"
  # Atomic: copy to a temp name, verify the transferred bytes, then promote.
  RCLONE copyto "$src" "$dest.uploading" \
    || sync_fail "rclone upload failed for $name"
  remote_sha=$(RCLONE cat "$dest.uploading" | sha256sum | cut -d' ' -f1)
  [ "$remote_sha" = "$sha" ] \
    || sync_fail "post-transfer checksum mismatch for $name (local=$sha remote=$remote_sha)"
  RCLONE moveto "$dest.uploading" "$dest" \
    || sync_fail "rclone promote (moveto) failed for $name"
  RCLONE copyto "$sidecar" "$dest.sha256" \
    || sync_fail "rclone sidecar upload failed for $name.sha256"
}

sync_artifact "$LATEST_DUMP" "$REMOTE_LATEST/$DUMP_NAME" "$DUMP_NAME"
sync_artifact "$LATEST_GLOBALS" "$REMOTE_LATEST/$GLOBALS_NAME" "$GLOBALS_NAME"
sync_artifact "$LATEST_STATE" "$REMOTE_LATEST/$STATE_NAME" "$STATE_NAME"
EVIDENCE_NAME=""
EVIDENCE_SHA=""
EVIDENCE_SIZE=""
if [ -n "$LATEST_EVIDENCE" ]; then
  EVIDENCE_NAME=$(basename "$LATEST_EVIDENCE")
  EVIDENCE_SHA=$(sha256sum "$LATEST_EVIDENCE" | cut -d' ' -f1)
  EVIDENCE_SIZE=$(wc -c < "$LATEST_EVIDENCE" | tr -d '[:space:]')
  sync_artifact "$LATEST_EVIDENCE" "$REMOTE_LATEST/$EVIDENCE_NAME" "$EVIDENCE_NAME"
fi
PRE_MIGRATE_NAME=""
PRE_MIGRATE_SHA=""
PRE_MIGRATE_SIZE=""
if [ -n "$LATEST_PRE_MIGRATE" ]; then
  PRE_MIGRATE_NAME="pre-migrate-$(basename "$LATEST_PRE_MIGRATE")"
  PRE_MIGRATE_SHA=$(sha256sum "$LATEST_PRE_MIGRATE" | cut -d' ' -f1)
  PRE_MIGRATE_SIZE=$(wc -c < "$LATEST_PRE_MIGRATE" | tr -d '[:space:]')
  sync_artifact "$LATEST_PRE_MIGRATE" "$REMOTE_LATEST/$PRE_MIGRATE_NAME" "$PRE_MIGRATE_NAME"
fi

{
  printf 'manifest_version=2\n'
  printf 'backup_prefix=%s\n' "$DB_PREFIX"
  printf 'created_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'dump_name=%s\n' "$DUMP_NAME"
  printf 'dump_sha256=%s\n' "$DUMP_SHA"
  printf 'dump_size=%s\n' "$DUMP_SIZE"
  printf 'globals_name=%s\n' "$GLOBALS_NAME"
  printf 'globals_sha256=%s\n' "$GLOBALS_SHA"
  printf 'globals_size=%s\n' "$GLOBALS_SIZE"
  printf 'state_name=%s\n' "$STATE_NAME"
  printf 'state_sha256=%s\n' "$STATE_SHA"
  printf 'state_size=%s\n' "$STATE_SIZE"
  printf 'evidence_name=%s\n' "$EVIDENCE_NAME"
  printf 'evidence_sha256=%s\n' "$EVIDENCE_SHA"
  printf 'evidence_size=%s\n' "$EVIDENCE_SIZE"
  printf 'pre_migrate_name=%s\n' "$PRE_MIGRATE_NAME"
  printf 'pre_migrate_sha256=%s\n' "$PRE_MIGRATE_SHA"
  printf 'pre_migrate_size=%s\n' "$PRE_MIGRATE_SIZE"
} > "$MANIFEST_TMP"
RCLONE copyto "$MANIFEST_TMP" "$REMOTE_LATEST/manifest.uploading" \
  || sync_fail "rclone manifest upload failed"
RCLONE moveto "$REMOTE_LATEST/manifest.uploading" "$REMOTE_LATEST/manifest.tsv" \
  || sync_fail "rclone manifest promotion failed"
RCLONE cat "$REMOTE_LATEST/manifest.tsv" | cmp - "$MANIFEST_TMP" \
  || sync_fail "remote manifest verification failed"

date +%s > "$SUCCESS_MARKER" \
  || sync_fail "could not write offsite success marker: $SUCCESS_MARKER"
resolve_alert
log "offsite sync OK — $DUMP_NAME + globals + state sidecar + evidence + manifest promoted to $REMOTE_LATEST"
