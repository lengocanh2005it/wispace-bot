#!/usr/bin/env bash
set -euo pipefail

# Nightly pg_dump of the shared bot database (all 3 bots use ai_chat_bot_db).
# Run on the VPS host; credentials come from the messenger-bot .env.
#
# Install:
#   cp deploy/postgres-backup.sh /home/ngoc_anh/scripts/postgres-backup.sh
#   chmod +x /home/ngoc_anh/scripts/postgres-backup.sh
#   crontab -e  # add:
#   0 2 * * * /home/ngoc_anh/scripts/postgres-backup.sh >> /home/ngoc_anh/backups/backup.log 2>&1

ENV_FILE="${ENV_FILE:-/home/ngoc_anh/messenger-bot/.env}"
BACKUP_DIR="${BACKUP_DIR:-/home/ngoc_anh/backups/ai_chat_bot_db}"
KEEP_DAYS="${KEEP_DAYS:-14}"
DB_CONTAINER="${DB_CONTAINER:-postgres_db}"

DB_USER=$(grep -E '^DB_USER=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
DB_NAME=$(grep -E '^DB_NAME=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
DB_PASSWORD=$(grep -E '^DB_PASSWORD=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'")

if [ -z "$DB_USER" ] || [ -z "$DB_NAME" ] || [ -z "$DB_PASSWORD" ]; then
  echo "ERROR: missing DB_* in $ENV_FILE" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
OUT="$BACKUP_DIR/${DB_NAME}-${STAMP}.sql.gz"

docker exec -e PGPASSWORD="$DB_PASSWORD" "$DB_CONTAINER" \
  pg_dump -U "$DB_USER" -d "$DB_NAME" -h localhost --no-owner 2>/dev/null | gzip > "$OUT"

echo "Backup written: $OUT ($(du -h "$OUT" | cut -f1))"

find "$BACKUP_DIR" -name "${DB_NAME}-*.sql.gz" -mtime +"$KEEP_DAYS" -delete
echo "Old backups (older than ${KEEP_DAYS}d) pruned"
