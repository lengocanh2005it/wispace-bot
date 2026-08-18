#!/usr/bin/env bash
set -euo pipefail

# Nightly pg_dump of the shared bot database (all 3 bots use ai_chat_bot_db).
# Run on the VPS host; credentials come from the messenger-bot .env.
# Backups are encrypted at rest with GPG symmetric AES-256 (#185).
#
# Install:
#   cp deploy/postgres-backup.sh /home/ngoc_anh/scripts/postgres-backup.sh
#   chmod +x /home/ngoc_anh/scripts/postgres-backup.sh
#   crontab -e  # add:
#   0 2 * * * /home/ngoc_anh/scripts/postgres-backup.sh >> /home/ngoc_anh/backups/backup.log 2>&1

ENV_FILE="${ENV_FILE:-/home/ngoc_anh/messenger-bot/.env}"
BACKUP_DIR="${BACKUP_DIR:-/home/ngoc_anh/backups/ai_chat_bot_db}"
KEEP_DAYS="${KEEP_DAYS:-14}"
DB_CONTAINER="${DB_CONTAINER:-postgres_n8n_db}"
ALERTMANAGER_URL="${ALERTMANAGER_URL:-http://127.0.0.1:9093}"
BACKUP_ALERT="postgres_backup_failed"

# Backups hold PII + OAuth/linking material — restrict file creation (600)
# and lock down the backup directory (700) (#204/#185).
umask 077
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

DB_USER=$(grep -E '^DB_USER=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
DB_NAME=$(grep -E '^DB_NAME=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
DB_PASSWORD=$(grep -E '^DB_PASSWORD=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
BACKUP_PASSPHRASE=$(grep -E '^BACKUP_ENCRYPTION_PASSPHRASE=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'")

if [ -z "$DB_USER" ] || [ -z "$DB_NAME" ] || [ -z "$DB_PASSWORD" ]; then
  echo "ERROR: missing DB_* in $ENV_FILE" >&2
  exit 1
fi

if [ -z "$BACKUP_PASSPHRASE" ]; then
  echo "ERROR: missing BACKUP_ENCRYPTION_PASSPHRASE in $ENV_FILE" >&2
  exit 1
fi

STAMP=$(date +%Y%m%d-%H%M%S)
OUT="$BACKUP_DIR/${DB_NAME}-${STAMP}.sql.gz.gpg"
TMP="$OUT.tmp"
GPG_TMP="$OUT.gpg.tmp"
FAILURE_MARKER="$BACKUP_DIR/.last-backup-failed"
SUCCESS_MARKER="$BACKUP_DIR/.last-backup-success"

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

notify_backup_failed() { # summary description
  post_alert "$BACKUP_ALERT" "{\"summary\":\"$1\",\"description\":\"$2\"}"
}

resolve_backup() {
  post_alert "$BACKUP_ALERT" "{}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

# Keep stderr for failure detection (no 2>/dev/null) — a failed pg_dump must
# not leave a silent half-written gzip on disk.
if docker exec -e PGPASSWORD="$DB_PASSWORD" "$DB_CONTAINER" \
  pg_dump -U "$DB_USER" -d "$DB_NAME" -h localhost --no-owner 2>"$BACKUP_DIR/.pgdump.err" | gzip > "$TMP"; then
  # Validate the archive is a complete gzip before promoting it.
  if gzip -t "$TMP" 2>/dev/null && [ -s "$TMP" ]; then
    # Encrypt at rest with GPG symmetric AES-256 (#185).
    if gpg --batch --yes --symmetric --cipher-algo AES256 \
      --passphrase "$BACKUP_PASSPHRASE" --output "$GPG_TMP" "$TMP"; then
      if [ -s "$GPG_TMP" ]; then
        mv "$GPG_TMP" "$OUT"
        rm -f "$TMP"
        rm -f "$FAILURE_MARKER"
        date +%s > "$SUCCESS_MARKER"
        resolve_backup
        echo "Backup written: $OUT ($(du -h "$OUT" | cut -f1))"
      else
        echo "ERROR: GPG encryption produced empty file — backup discarded" >&2
        rm -f "$TMP" "$GPG_TMP"
        touch "$FAILURE_MARKER"
        notify_backup_failed "Postgres backup failed" "GPG encryption produced empty file at $(date -Is)"
        exit 1
      fi
    else
      echo "ERROR: GPG encryption failed — see stderr" >&2
      rm -f "$TMP" "$GPG_TMP"
      touch "$FAILURE_MARKER"
      notify_backup_failed "Postgres backup failed" "GPG encryption failed at $(date -Is)"
      exit 1
    fi
  else
    echo "ERROR: gzip validation failed for $TMP — backup discarded" >&2
    rm -f "$TMP"
    touch "$FAILURE_MARKER"
    notify_backup_failed "Postgres backup failed" "gzip validation failed at $(date -Is)"
    exit 1
  fi
else
  echo "ERROR: pg_dump failed — see $BACKUP_DIR/.pgdump.err" >&2
  rm -f "$TMP"
  touch "$FAILURE_MARKER"
  notify_backup_failed "Postgres backup failed" "pg_dump failed at $(date -Is); see $BACKUP_DIR/.pgdump.err"
  exit 1
fi

find "$BACKUP_DIR" -name "${DB_NAME}-*.sql.gz.gpg" -mtime +"$KEEP_DAYS" -delete
find "$BACKUP_DIR" -name "${DB_NAME}-*.sql.gz" -mtime +"$KEEP_DAYS" -delete
echo "Old backups (older than ${KEEP_DAYS}d) pruned"

if [ -f "$FAILURE_MARKER" ]; then
  echo "WARN: previous backup run failed (marker present) — check backups" >&2
fi
