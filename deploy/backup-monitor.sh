#!/usr/bin/env bash
set -euo pipefail

# Hourly backup health check (#185/#866). Three layers:
#   1. Local freshness — nightly backup success marker age (25h threshold).
#   2. Offsite freshness (#866) — the latest remote artifact set must be
#      present and recent. Uses the offsite-sync marker as the signal;
#      a failed/missing sync never counts as healthy.
#   3. Decryptability (bounded) — with RUN_RESTORE_VERIFY=1 (weekly cron),
#      runs the guarded restore verifier against the latest local pair so
#      backup health reflects recoverability, not just existence.
# Alerts are bounded: fire once while unhealthy, resolved with ends_at.
#
# Install (hourly cron):
#   cp deploy/backup-monitor.sh /home/ngoc_anh/scripts/backup-monitor.sh
#   chmod +x /home/ngoc_anh/scripts/backup-monitor.sh
#   crontab -e  # add:
#   0 * * * * /home/ngoc_anh/scripts/backup-monitor.sh >> /home/ngoc_anh/backups/monitor.log 2>&1
# Weekly decryptability (separate cron, e.g. Sunday 04:00):
#   0 4 * * 0 RUN_RESTORE_VERIFY=1 /home/ngoc_anh/scripts/backup-monitor.sh >> /home/ngoc_anh/backups/monitor.log 2>&1

BACKUP_DIR="${BACKUP_DIR:-/home/ngoc_anh/backups/ai_chat_bot_db}"
SUCCESS_MARKER="$BACKUP_DIR/.last-backup-success"
OFFSITE_MARKER="$BACKUP_DIR/.last-offsite-success"
MAX_BACKUP_AGE_HOURS="${MAX_BACKUP_AGE_HOURS:-25}"
MAX_OFFSITE_AGE_HOURS="${MAX_OFFSITE_AGE_HOURS:-25}"
ALERTMANAGER_URL="${ALERTMANAGER_URL:-http://127.0.0.1:9093}"
BACKUP_STALE_ALERT="postgres_backup_stale"
OFFSITE_STALE_ALERT="postgres_offsite_stale"
RUN_RESTORE_VERIFY="${RUN_RESTORE_VERIFY:-0}"
RESTORE_VERIFY_SCRIPT="${RESTORE_VERIFY_SCRIPT:-/home/ngoc_anh/scripts/postgres-restore-verify.sh}"

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

EXIT_CODE=0

# --- 1. Local backup freshness -------------------------------------------------
if [ ! -f "$SUCCESS_MARKER" ]; then
  echo "ERROR: no backup success marker found at $SUCCESS_MARKER" >&2
  post_alert "$BACKUP_STALE_ALERT" \
    "{\"summary\":\"Postgres backup never succeeded\",\"description\":\"No success marker at $SUCCESS_MARKER — nightly backup may not be installed.\"}"
  EXIT_CODE=1
else
  LAST_SUCCESS=$(cat "$SUCCESS_MARKER")
  NOW=$(date +%s)
  AGE_SECONDS=$((NOW - LAST_SUCCESS))
  AGE_HOURS=$((AGE_SECONDS / 3600))

  if [ "$AGE_HOURS" -ge "$MAX_BACKUP_AGE_HOURS" ]; then
    echo "ERROR: last backup is ${AGE_HOURS}h old (threshold ${MAX_BACKUP_AGE_HOURS}h)" >&2
    post_alert "$BACKUP_STALE_ALERT" \
      "{\"summary\":\"Postgres backup stale (${AGE_HOURS}h)\",\"description\":\"Last successful backup was $(date -d "@$LAST_SUCCESS" -Is 2>/dev/null || date -r "$LAST_SUCCESS" -Is 2>/dev/null || echo "$LAST_SUCCESS") — threshold is ${MAX_BACKUP_AGE_HOURS}h.\"}"
    EXIT_CODE=1
  else
    # Backup is fresh — resolve any stale alert.
    post_alert "$BACKUP_STALE_ALERT" "{}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "Backup OK: last success ${AGE_HOURS}h ago (threshold ${MAX_BACKUP_AGE_HOURS}h)"
  fi
fi

# --- 2. Offsite freshness (#866) -----------------------------------------------
if [ ! -f "$OFFSITE_MARKER" ]; then
  echo "ERROR: no offsite sync marker at $OFFSITE_MARKER — offsite replication missing" >&2
  post_alert "$OFFSITE_STALE_ALERT" \
    "{\"summary\":\"Offsite backup missing\",\"description\":\"No .last-offsite-success marker — postgres-offsite-sync.sh has never succeeded.\"}"
  EXIT_CODE=1
else
  OFFSITE_AGE_HOURS=$(( ($(date +%s) - $(cat "$OFFSITE_MARKER")) / 3600 ))
  if [ "$OFFSITE_AGE_HOURS" -ge "$MAX_OFFSITE_AGE_HOURS" ]; then
    echo "ERROR: offsite sync is ${OFFSITE_AGE_HOURS}h old (threshold ${MAX_OFFSITE_AGE_HOURS}h)" >&2
    post_alert "$OFFSITE_STALE_ALERT" \
      "{\"summary\":\"Offsite backup stale (${OFFSITE_AGE_HOURS}h)\",\"description\":\"Last successful offsite sync exceeded ${MAX_OFFSITE_AGE_HOURS}h — check offsite-sync.log and rclone credentials.\"}"
    EXIT_CODE=1
  else
    post_alert "$OFFSITE_STALE_ALERT" "{}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "Offsite OK: last sync ${OFFSITE_AGE_HOURS}h ago (threshold ${MAX_OFFSITE_AGE_HOURS}h)"
  fi
fi

# --- 3. Decryptability (bounded weekly run) ------------------------------------
if [ "$RUN_RESTORE_VERIFY" = "1" ]; then
  if [ ! -f "$RESTORE_VERIFY_SCRIPT" ]; then
    echo "WARN: restore verifier not found at $RESTORE_VERIFY_SCRIPT — skipping decryptability check" >&2
  else
    LATEST_DUMP=$(ls -1t "$BACKUP_DIR"/*.sql.gz.gpg 2>/dev/null | grep -v globals | head -1 || true)
    if [ -n "$LATEST_DUMP" ]; then
      DB_PREFIX=$(basename "$LATEST_DUMP")
      DB_PREFIX=${DB_PREFIX%%.sql.gz.gpg}
      bash "$RESTORE_VERIFY_SCRIPT" \
        --artifact "$LATEST_DUMP" \
        --globals-artifact "$BACKUP_DIR/${DB_PREFIX}.globals.sql.gz.gpg" \
        --passphrase-file "${ENV_FILE:-/home/ngoc_anh/messenger-bot/.env}" \
        --env-file "${ENV_FILE:-/home/ngoc_anh/messenger-bot/.env}" \
        --evidence-dir "$BACKUP_DIR/restore-verify" \
        --target disposable \
        || { echo "ERROR: restore verification FAILED — backup not recoverable" >&2
             post_alert "$OFFSITE_STALE_ALERT" \
               "{\"summary\":\"Backup restore verification failed\",\"description\":\"The guarded restore verifier could not recover the latest backup pair — see restore-verify evidence.\"}"
             EXIT_CODE=1; }
    else
      echo "WARN: no local artifacts for restore verification" >&2
    fi
  fi
fi

exit "$EXIT_CODE"
