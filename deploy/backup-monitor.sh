#!/usr/bin/env bash
set -euo pipefail

# Hourly check that the nightly pg_dump completed successfully.
# Fires an Alertmanager alert when the last successful backup is older
# than MAX_BACKUP_AGE_HOURS (default 25). Resolves the alert on success.
#
# Install (hourly cron):
#   cp deploy/backup-monitor.sh /home/ngoc_anh/scripts/backup-monitor.sh
#   chmod +x /home/ngoc_anh/scripts/backup-monitor.sh
#   crontab -e  # add:
#   0 * * * * /home/ngoc_anh/scripts/backup-monitor.sh >> /home/ngoc_anh/backups/monitor.log 2>&1

BACKUP_DIR="${BACKUP_DIR:-/home/ngoc_anh/backups/ai_chat_bot_db}"
SUCCESS_MARKER="$BACKUP_DIR/.last-backup-success"
MAX_BACKUP_AGE_HOURS="${MAX_BACKUP_AGE_HOURS:-25}"
ALERTMANAGER_URL="${ALERTMANAGER_URL:-http://127.0.0.1:9093}"
BACKUP_STALE_ALERT="postgres_backup_stale"

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

if [ ! -f "$SUCCESS_MARKER" ]; then
  echo "ERROR: no backup success marker found at $SUCCESS_MARKER" >&2
  post_alert "$BACKUP_STALE_ALERT" \
    "{\"summary\":\"Postgres backup never succeeded\",\"description\":\"No success marker at $SUCCESS_MARKER — nightly backup may not be installed.\"}"
  exit 1
fi

LAST_SUCCESS=$(cat "$SUCCESS_MARKER")
NOW=$(date +%s)
AGE_SECONDS=$((NOW - LAST_SUCCESS))
AGE_HOURS=$((AGE_SECONDS / 3600))

if [ "$AGE_HOURS" -ge "$MAX_BACKUP_AGE_HOURS" ]; then
  echo "ERROR: last backup is ${AGE_HOURS}h old (threshold ${MAX_BACKUP_AGE_HOURS}h)" >&2
  post_alert "$BACKUP_STALE_ALERT" \
    "{\"summary\":\"Postgres backup stale (${AGE_HOURS}h)\",\"description\":\"Last successful backup was $(date -d "@$LAST_SUCCESS" -Is 2>/dev/null || date -r "$LAST_SUCCESS" -Is 2>/dev/null || echo "$LAST_SUCCESS") — threshold is ${MAX_BACKUP_AGE_HOURS}h.\"}"
  exit 1
fi

# Backup is fresh — resolve any stale alert.
post_alert "$BACKUP_STALE_ALERT" "{}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Backup OK: last success ${AGE_HOURS}h ago (threshold ${MAX_BACKUP_AGE_HOURS}h)"
