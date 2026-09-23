#!/usr/bin/env bash
set -euo pipefail

# Hourly backup health check (#185/#866). It checks local freshness, the
# remote manifest/object set, and (weekly) downloads the remote pair through
# the guarded restore verifier. A local success marker is never enough to make
# offsite backup health green.
#
# Install (hourly):
#   0 * * * * /home/ngoc_anh/scripts/backup-monitor.sh >> /home/ngoc_anh/backups/monitor.log 2>&1
# Weekly remote decryptability:
#   0 4 * * 0 RUN_RESTORE_VERIFY=1 /home/ngoc_anh/scripts/backup-monitor.sh >> /home/ngoc_anh/backups/monitor.log 2>&1

# Immediate startup banner so executions always leave an observable signal (#1325).
echo "[$(date -Is)] [backup-monitor] Starting backup health and drift check..."

BACKUP_DIR="${BACKUP_DIR:-/home/ngoc_anh/backups/ai_chat_bot_db}"
ENV_FILE="${ENV_FILE:-/home/ngoc_anh/backups/ai_chat_bot_db/backup.env}"
SUCCESS_MARKER="$BACKUP_DIR/.last-backup-success"
OFFSITE_MARKER="$BACKUP_DIR/.last-offsite-success"
MAX_BACKUP_AGE_HOURS="${MAX_BACKUP_AGE_HOURS:-25}"
MAX_OFFSITE_AGE_HOURS="${MAX_OFFSITE_AGE_HOURS:-25}"
ALERTMANAGER_URL="${ALERTMANAGER_URL:-http://127.0.0.1:9093}"
BACKUP_STALE_ALERT="postgres_backup_stale"
OFFSITE_STALE_ALERT="postgres_offsite_stale"
RUN_RESTORE_VERIFY="${RUN_RESTORE_VERIFY:-0}"
RESTORE_VERIFY_SCRIPT="${RESTORE_VERIFY_SCRIPT:-/home/ngoc_anh/scripts/postgres-restore-verify.sh}"
HOST_SCRIPTS_DIR="${HOST_SCRIPTS_DIR:-/home/ngoc_anh/scripts}"
MANIFEST_FILE="${HOST_MANIFEST_FILE:-$HOST_SCRIPTS_DIR/.installed-manifest.json}"
DRIFT_ALERT="host_scripts_drift_detected"
CHECK_SCRIPT_DRIFT="${CHECK_SCRIPT_DRIFT:-1}"

TMP_DIR=""
RCLONE_CONF=""
REMOTE_LATEST=""
REMOTE_DUMP_NAME=""
REMOTE_DUMP_SHA=""
REMOTE_GLOBALS_NAME=""
REMOTE_GLOBALS_SHA=""
REMOTE_EVIDENCE_NAME=""
REMOTE_EVIDENCE_SHA=""
REMOTE_PRE_MIGRATE_NAME=""
REMOTE_PRE_MIGRATE_SHA=""
REMOTE_STATE_NAME=""
REMOTE_STATE_SHA=""

cleanup() {
  [ -z "$TMP_DIR" ] || rm -rf "$TMP_DIR"
  [ -z "$RCLONE_CONF" ] || rm -f "$RCLONE_CONF"
}
trap cleanup EXIT INT TERM

json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

post_alert() { # alertname summary description [ends_at]
  local alertname="$1" summary description body
  body="[{\"labels\":{\"alertname\":\"$alertname\",\"severity\":\"critical\"},\"annotations\":"
  if [ -n "$2$3" ]; then
    summary=$(json_escape "$2")
    description=$(json_escape "$3")
    body="$body{\"summary\":\"$summary\",\"description\":\"$description\"}"
  else
    body="$body{}"
  fi
  if [ -n "${4:-}" ]; then body="$body,\"endsAt\":\"$4\""; fi
  body="$body}]"
  curl -sf -X POST "$ALERTMANAGER_URL/api/v2/alerts" \
    -H 'Content-Type: application/json' -d "$body" >/dev/null 2>&1 \
    || echo "WARN [$(date -Is)] Alertmanager notify failed (curl)" >&2
}

on_monitor_error() {
  local exit_code="$1" line="$2"
  echo "ERROR [$(date -Is)]: backup-monitor failed at line $line with exit code $exit_code" >&2
  post_alert "backup_monitor_failed" "Backup monitor crashed" "Script error at line $line with exit code $exit_code" 2>/dev/null || true
}
trap 'on_monitor_error $? $LINENO' ERR

resolve_alert() {
  post_alert "$1" "" "" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

env_value() { # NAME FILE
  grep -E "^$1=" "$2" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true
}

read_marker() { # FILE
  local value
  [ -f "$1" ] || return 1
  value=$(cat "$1")
  printf '%s' "$value" | grep -Eq '^[0-9]+$' || return 1
  printf '%s' "$value"
}

check_age() { # FILE LABEL MAX_HOURS
  local marker="$1" label="$2" max_hours="$3" now age_seconds age_hours
  if ! marker=$(read_marker "$marker"); then
    echo "ERROR: $label success marker is missing or invalid" >&2
    return 1
  fi
  now=$(date +%s)
  [ "$marker" -le "$now" ] || {
    echo "ERROR: $label success marker is in the future" >&2
    return 1
  }
  age_seconds=$((now - marker))
  age_hours=$((age_seconds / 3600))
  if [ "$age_hours" -ge "$max_hours" ]; then
    echo "ERROR: $label is ${age_hours}h old (threshold ${max_hours}h)" >&2
    return 1
  fi
  echo "$label OK: last success ${age_hours}h ago (threshold ${max_hours}h)"
}

load_offsite_config() {
  local endpoint bucket access_key secret_key region
  command -v rclone >/dev/null || return 1
  command -v sha256sum >/dev/null || return 1
  [ -f "$ENV_FILE" ] || return 1
  endpoint=$(env_value OFFSITE_S3_ENDPOINT "$ENV_FILE")
  bucket=$(env_value OFFSITE_S3_BUCKET "$ENV_FILE")
  access_key=$(env_value OFFSITE_S3_ACCESS_KEY "$ENV_FILE")
  secret_key=$(env_value OFFSITE_S3_SECRET_KEY "$ENV_FILE")
  region=$(env_value OFFSITE_S3_REGION "$ENV_FILE")
  [ -n "$endpoint" ] && [ -n "$bucket" ] && [ -n "$access_key" ] && [ -n "$secret_key" ] || return 1

  RCLONE_CONF=$(mktemp "${TMPDIR:-/tmp}/backup-monitor-rclone.XXXXXX")
  chmod 600 "$RCLONE_CONF" || return 1
  {
    echo '[offsite]'
    echo 'type = s3'
    echo 'provider = Other'
    echo "endpoint = $endpoint"
    [ -n "$region" ] && echo "region = $region"
  } > "$RCLONE_CONF"
  REMOTE_LATEST="offsite:$bucket/latest"
}

RCLONE() {
  local endpoint access_key secret_key
  endpoint=$(env_value OFFSITE_S3_ENDPOINT "$ENV_FILE")
  access_key=$(env_value OFFSITE_S3_ACCESS_KEY "$ENV_FILE")
  secret_key=$(env_value OFFSITE_S3_SECRET_KEY "$ENV_FILE")
  RCLONE_CONFIG="$RCLONE_CONF" RCLONE_CONFIG_OFFSITE_TYPE=s3 \
    RCLONE_CONFIG_OFFSITE_ENDPOINT="$endpoint" \
    RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID="$access_key" \
    RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY="$secret_key" \
    rclone "$@"
}

manifest_value() { # KEY FILE
  awk -F= -v key="$1" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$2"
}

valid_remote_name() {
  printf '%s' "$1" | grep -Eq '^[A-Za-z0-9_.-]+$' && [[ "$1" != *..* ]]
}

verify_remote_artifact() { # NAME SHA
  local name="$1" sha="$2" sidecar expected
  valid_remote_name "$name" || return 1
  printf '%s' "$sha" | grep -Eq '^[0-9a-f]{64}$' || return 1
  RCLONE lsl "$REMOTE_LATEST/$name" >/dev/null 2>&1 || return 1
  sidecar="$TMP_DIR/$name.sha256"
  RCLONE cat "$REMOTE_LATEST/$name.sha256" > "$sidecar" 2>/dev/null || return 1
  expected="$sha  $name"
  printf '%s\n' "$expected" | cmp -s - "$sidecar"
}

verify_remote_manifest() {
  local manifest="$TMP_DIR/remote-manifest.tsv"
  RCLONE cat "$REMOTE_LATEST/manifest.tsv" > "$manifest" 2>/dev/null || return 1
  [ -s "$manifest" ] || return 1

  REMOTE_DUMP_NAME=$(manifest_value dump_name "$manifest")
  REMOTE_DUMP_SHA=$(manifest_value dump_sha256 "$manifest")
  REMOTE_GLOBALS_NAME=$(manifest_value globals_name "$manifest")
  REMOTE_GLOBALS_SHA=$(manifest_value globals_sha256 "$manifest")
  REMOTE_EVIDENCE_NAME=$(manifest_value evidence_name "$manifest")
  REMOTE_EVIDENCE_SHA=$(manifest_value evidence_sha256 "$manifest")
  REMOTE_PRE_MIGRATE_NAME=$(manifest_value pre_migrate_name "$manifest")
  REMOTE_PRE_MIGRATE_SHA=$(manifest_value pre_migrate_sha256 "$manifest")
  REMOTE_STATE_NAME=$(manifest_value state_name "$manifest")
  REMOTE_STATE_SHA=$(manifest_value state_sha256 "$manifest")

  verify_remote_artifact "$REMOTE_DUMP_NAME" "$REMOTE_DUMP_SHA" || return 1
  verify_remote_artifact "$REMOTE_GLOBALS_NAME" "$REMOTE_GLOBALS_SHA" || return 1
  # The state sidecar is mandatory for the weekly verifier run (#879); on v1
  # remote sets (pre-#879) the hourly freshness check stays green and only the
  # weekly restore verification fails closed.
  if [ -n "$REMOTE_STATE_NAME" ]; then
    verify_remote_artifact "$REMOTE_STATE_NAME" "$REMOTE_STATE_SHA" || return 1
  fi
  if [ -n "$REMOTE_EVIDENCE_NAME" ]; then
    verify_remote_artifact "$REMOTE_EVIDENCE_NAME" "$REMOTE_EVIDENCE_SHA" || return 1
  fi
  if [ -n "$REMOTE_PRE_MIGRATE_NAME" ]; then
    verify_remote_artifact "$REMOTE_PRE_MIGRATE_NAME" "$REMOTE_PRE_MIGRATE_SHA" || return 1
  fi

  return 0
}

download_and_verify_remote() {
  local remote_dir="$TMP_DIR/remote-restore" dump globals state dump_sha globals_sha state_sha name sha path
  mkdir -p "$remote_dir"
  dump="$remote_dir/$REMOTE_DUMP_NAME"
  globals="$remote_dir/$REMOTE_GLOBALS_NAME"
  RCLONE copyto "$REMOTE_LATEST/$REMOTE_DUMP_NAME" "$dump" >/dev/null 2>&1 || return 1
  RCLONE copyto "$REMOTE_LATEST/$REMOTE_GLOBALS_NAME" "$globals" >/dev/null 2>&1 || return 1
  dump_sha=$(sha256sum "$dump" | cut -d' ' -f1)
  globals_sha=$(sha256sum "$globals" | cut -d' ' -f1)
  [ "$dump_sha" = "$REMOTE_DUMP_SHA" ] || return 1
  [ "$globals_sha" = "$REMOTE_GLOBALS_SHA" ] || return 1
  state="$remote_dir/$REMOTE_STATE_NAME"
  if [ -z "$REMOTE_STATE_NAME" ]; then
    # v1 remote set: no state sidecar to download — the weekly verify fails
    # closed below when the verifier is invoked without its expectation (#879).
    return 1
  fi
  RCLONE copyto "$REMOTE_LATEST/$REMOTE_STATE_NAME" "$state" >/dev/null 2>&1 || return 1
  state_sha=$(sha256sum "$state" | cut -d' ' -f1)
  [ "$state_sha" = "$REMOTE_STATE_SHA" ] || return 1
  for name in "$REMOTE_EVIDENCE_NAME" "$REMOTE_PRE_MIGRATE_NAME"; do
    [ -n "$name" ] || continue
    case "$name" in
      "$REMOTE_EVIDENCE_NAME") sha="$REMOTE_EVIDENCE_SHA" ;;
      *) sha="$REMOTE_PRE_MIGRATE_SHA" ;;
    esac
    path="$remote_dir/$name"
    RCLONE copyto "$REMOTE_LATEST/$name" "$path" >/dev/null 2>&1 || return 1
    actual=$(sha256sum "$path" | cut -d' ' -f1)
    [ "$actual" = "$sha" ] || return 1
  done
  bash "$RESTORE_VERIFY_SCRIPT" \
    --artifact "$dump" \
    --globals-artifact "$globals" \
    --state-artifact "$state" \
    --passphrase-file "$ENV_FILE" \
    --env-file "$ENV_FILE" \
    --evidence-dir "$BACKUP_DIR/restore-verify" \
    --target disposable
}

verify_host_scripts_drift() {
  if [ "$CHECK_SCRIPT_DRIFT" != "1" ]; then
    return 0
  fi

  if [ ! -s "$MANIFEST_FILE" ]; then
    echo "ERROR: host script manifest missing or empty at $MANIFEST_FILE" >&2
    post_alert "$DRIFT_ALERT" "Host scripts drift detected" "Host script manifest is missing or empty at $MANIFEST_FILE"
    return 1
  fi

  local drift_found=0
  local drift_reason=""
  local verified_count=0

  local in_scripts=0
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ "$line" =~ \"scripts\":[[:space:]]*\{ ]]; then
      in_scripts=1
      continue
    fi
    if [ "$in_scripts" -eq 1 ]; then
      if [[ "$line" =~ \} ]]; then
        in_scripts=0
        break
      fi
      if [[ "$line" =~ \"([^\"]+)\":[[:space:]]*\"([^\"]+)\" ]]; then
        local script_name="${BASH_REMATCH[1]}"
        local expected_sha="${BASH_REMATCH[2]}"

        # Prevent path traversal and malformed inputs (#1325 review)
        if ! [[ "$script_name" =~ ^[a-zA-Z0-9_.-]+$ ]] || [[ "$script_name" == *"/"* ]] || [[ "$script_name" == *".."* ]]; then
          echo "ERROR: invalid script name in manifest: $script_name" >&2
          drift_found=1
          drift_reason="Invalid script name in manifest: $script_name"
          break
        fi

        if ! [[ "$expected_sha" =~ ^[0-9a-f]{64}$ ]]; then
          echo "ERROR: invalid sha256 checksum in manifest for $script_name" >&2
          drift_found=1
          drift_reason="Invalid sha256 in manifest for $script_name"
          break
        fi

        local script_path="$HOST_SCRIPTS_DIR/$script_name"

        if [ ! -f "$script_path" ]; then
          echo "ERROR: host script missing: $script_path" >&2
          drift_found=1
          drift_reason="Missing script: $script_name"
          break
        fi

        if [ ! -x "$script_path" ]; then
          echo "ERROR: host script is not executable: $script_path" >&2
          drift_found=1
          drift_reason="Script not executable: $script_name"
          break
        fi

        local actual_sha
        actual_sha=$(sha256sum "$script_path" | cut -d' ' -f1)
        if [ "$actual_sha" != "$expected_sha" ]; then
          echo "ERROR: host script checksum mismatch for $script_name (expected $expected_sha, got $actual_sha)" >&2
          drift_found=1
          drift_reason="Checksum mismatch for $script_name"
          break
        fi

        verified_count=$((verified_count + 1))
      fi
    fi
  done < "$MANIFEST_FILE"

  if [ "$drift_found" -ne 0 ] || [ "$verified_count" -lt 5 ]; then
    local reason="${drift_reason:-Manifest incomplete: only $verified_count/5 scripts verified}"
    post_alert "$DRIFT_ALERT" "Host scripts drift detected" "$reason"
    return 1
  fi

  resolve_alert "$DRIFT_ALERT"
  echo "Host operational scripts OK: checksums match manifest ($verified_count verified)"
  return 0
}

EXIT_CODE=0
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/backup-monitor.XXXXXX")

if ! verify_host_scripts_drift; then
  EXIT_CODE=1
fi

if ! check_age "$SUCCESS_MARKER" "Local backup" "$MAX_BACKUP_AGE_HOURS"; then
  post_alert "$BACKUP_STALE_ALERT" "Postgres backup stale" "Local backup success marker is missing, invalid, future-dated, or stale."
  EXIT_CODE=1
else
  resolve_alert "$BACKUP_STALE_ALERT"
fi

if ! check_age "$OFFSITE_MARKER" "Offsite sync" "$MAX_OFFSITE_AGE_HOURS"; then
  post_alert "$OFFSITE_STALE_ALERT" "Offsite backup stale" "Offsite success marker is missing, invalid, future-dated, or stale."
  EXIT_CODE=1
elif ! load_offsite_config || ! verify_remote_manifest; then
  echo "ERROR: offsite manifest or artifact set is missing, stale, or invalid" >&2
  post_alert "$OFFSITE_STALE_ALERT" "Offsite backup unusable" "The offsite manifest, artifact, or checksum sidecar could not be verified."
  EXIT_CODE=1
else
  resolve_alert "$OFFSITE_STALE_ALERT"
  echo "Offsite remote OK: manifest and artifact checksum sidecars verified"
  if [ "$RUN_RESTORE_VERIFY" = "1" ]; then
    if [ ! -f "$RESTORE_VERIFY_SCRIPT" ] || ! download_and_verify_remote; then
      echo "ERROR: remote restore verification FAILED — backup not recoverable" >&2
      post_alert "$OFFSITE_STALE_ALERT" "Backup restore verification failed" "The guarded verifier could not recover the remote backup pair."
      EXIT_CODE=1
    else
      echo "Remote restore verification OK"
    fi
  fi
fi

exit "$EXIT_CODE"
