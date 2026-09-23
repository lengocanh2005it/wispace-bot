#!/usr/bin/env bash
set -euo pipefail

# Nightly pg_dump of the shared bot database (all 3 bots use ai_chat_bot_db).
# Run on the VPS host; credentials come from the host-only Vault-rendered
# backup env, never from a bot container env.
# Backups are encrypted at rest with GPG symmetric AES-256 (#185).
#
# Install:
#   cp deploy/postgres-backup.sh /home/ngoc_anh/scripts/postgres-backup.sh
#   chmod +x /home/ngoc_anh/scripts/postgres-backup.sh
#   crontab -e  # add:
#   0 2 * * * /home/ngoc_anh/scripts/postgres-backup.sh >> /home/ngoc_anh/backups/backup.log 2>&1

ENV_FILE="${ENV_FILE:-/home/ngoc_anh/backups/ai_chat_bot_db/backup.env}"
BACKUP_DIR="${BACKUP_DIR:-/home/ngoc_anh/backups/ai_chat_bot_db}"
KEEP_DAYS="${KEEP_DAYS:-14}"
# Optional legacy client container. Managed HA deployments should install
# postgresql-client on the backup host; otherwise set DB_CONTAINER to any
# network-attached image that contains psql/pg_dump.
DB_CONTAINER="${DB_CONTAINER:-}"
ALERTMANAGER_URL="${ALERTMANAGER_URL:-http://127.0.0.1:9093}"
BACKUP_ALERT="postgres_backup_failed"
FAILURE_MARKER="$BACKUP_DIR/.last-backup-failed"
SUCCESS_MARKER="$BACKUP_DIR/.last-backup-success"

# Immediate startup banner so cron executions always leave an observable signal (#1325).
echo "[$(date -Is)] [postgres-backup] Starting PostgreSQL backup..."

json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

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
  local summary description
  summary=$(json_escape "$1")
  description=$(json_escape "$2")
  post_alert "$BACKUP_ALERT" "{\"summary\":\"$summary\",\"description\":\"$description\"}"
}

resolve_backup() {
  post_alert "$BACKUP_ALERT" "{}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

die() {
  local msg="$1"
  echo "ERROR [$(date -Is)]: $msg" >&2
  touch "$FAILURE_MARKER" 2>/dev/null || true
  notify_backup_failed "Postgres backup failed" "$msg" 2>/dev/null || true
  exit 1
}

on_error() {
  local exit_code="$1" line="$2"
  echo "ERROR [$(date -Is)]: postgres-backup failed at line $line with exit code $exit_code" >&2
  touch "$FAILURE_MARKER" 2>/dev/null || true
  notify_backup_failed "Postgres backup failed" "Script error at line $line with exit code $exit_code" 2>/dev/null || true
}
trap 'on_error $? $LINENO' ERR

cleanup() {
  rm -f "${PASSPHRASE_FD_FILE:-}" "${TMP:-}" "${GLOBALS_TMP:-}" "${STATE_TMP:-}" "${GPG_TMP:-}" "${GLOBALS_GPG_TMP:-}" "${STATE_GPG_TMP:-}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Backups hold PII + OAuth/linking material — restrict file creation (600)
# and lock down the backup directory (700) (#204/#185).
umask 077
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

if [ ! -f "$ENV_FILE" ]; then
  die "env file does not exist at $ENV_FILE"
fi

env_value() { # NAME FILE
  grep -E "^$1=" "$2" 2>/dev/null | tail -1 | cut -d= -f2- | sed -e 's/^["'"'"']//' -e 's/["'"'"']$//' || true
}

DB_USER=$(env_value DB_USER "$ENV_FILE")
DB_NAME=$(env_value DB_NAME "$ENV_FILE")
DB_PASSWORD=$(env_value DB_PASSWORD "$ENV_FILE")
DB_HOST=$(env_value DB_HOST "$ENV_FILE")
DB_PORT=$(env_value DB_PORT "$ENV_FILE")
BACKUP_PASSPHRASE=$(env_value BACKUP_ENCRYPTION_PASSPHRASE "$ENV_FILE")

DB_PORT="${DB_PORT:-5432}"
if [ -z "$DB_USER" ] || [ -z "$DB_NAME" ] || [ -z "$DB_PASSWORD" ] || [ -z "$DB_HOST" ]; then
  die "missing DB_* (including DB_HOST) in $ENV_FILE"
fi

if ! printf '%s' "$DB_HOST" | grep -Eq '^[a-zA-Z0-9._-]+$' || \
  ! printf '%s' "$DB_PORT" | grep -Eq '^[0-9]+$' ||
  [ "$DB_PORT" -lt 1 ] || [ "$DB_PORT" -gt 65535 ]; then
  die "invalid DB_HOST/DB_PORT in $ENV_FILE"
fi

if [ -z "$BACKUP_PASSPHRASE" ]; then
  die "missing BACKUP_ENCRYPTION_PASSPHRASE in $ENV_FILE"
fi

STAMP=$(date +%Y%m%d-%H%M%S)
OUT="$BACKUP_DIR/${DB_NAME}-${STAMP}.sql.gz.gpg"
TMP="$OUT.tmp"
GPG_TMP="$OUT.gpg.tmp"
STATE_OUT="$BACKUP_DIR/${DB_NAME}-${STAMP}.state.json.gz.gpg"
STATE_TMP="$STATE_OUT.tmp"
STATE_GPG_TMP="$STATE_OUT.gpg.tmp"
# Passphrase handoff file — fd 3 for GPG, mode 600, removed on exit (#865).
PASSPHRASE_FD_FILE="$BACKUP_DIR/.backup-passphrase.$$"
printf '%s' "$BACKUP_PASSPHRASE" > "$PASSPHRASE_FD_FILE"
chmod 600 "$PASSPHRASE_FD_FILE"

run_db_client() {
  if command -v "$1" >/dev/null 2>&1; then
    PGPASSWORD="$DB_PASSWORD" "$@"
  elif [ -n "$DB_CONTAINER" ]; then
    docker exec -e PGPASSWORD="$DB_PASSWORD" "$DB_CONTAINER" "$@"
  else
    echo "postgresql-client is unavailable; set DB_CONTAINER or install psql/pg_dump" >&2
    return 1
  fi
}

# Refuse to dump from a promoted standby. The endpoint is the same stable
# writer endpoint used by the bots, so a provider promotion needs no cron edit.
writer_status=$(run_db_client psql -v ON_ERROR_STOP=1 -h "$DB_HOST" -p "$DB_PORT" \
  -U "$DB_USER" -d "$DB_NAME" \
  -tAc 'SELECT NOT pg_is_in_recovery()' 2>"$BACKUP_DIR/.pgdump.err" | tr -d '[:space:]') || {
  echo "ERROR: database writer preflight failed — see $BACKUP_DIR/.pgdump.err" >&2
  touch "$FAILURE_MARKER"
  notify_backup_failed "Postgres backup failed" "writer endpoint preflight failed at $(date -Is)"
  exit 1
}
if [ "$writer_status" != "t" ]; then
  echo "ERROR: DB_HOST is not the writable primary — backup refused" >&2
  touch "$FAILURE_MARKER"
  notify_backup_failed "Postgres backup failed" "writer endpoint is read-only at $(date -Is)"
  exit 1
fi

# State sidecar (#879): capture the migration + table inventory BEFORE the
# dump. The restore verifier compares the restored database against this
# independent backup-time expectation — it never derives the expected set
# from the restored database itself.
json_lines_to_array() {
  awk 'BEGIN { ORS = ""; printf "[" }
    { if (NR > 1) printf ", "; printf "\"%s\"", $0 }
    END { printf "]" }'
}
MIGS_RAW=$(run_db_client psql -v ON_ERROR_STOP=1 -h "$DB_HOST" -p "$DB_PORT" \
  -U "$DB_USER" -d "$DB_NAME" \
  -tAc 'SELECT name FROM public.migrations ORDER BY name' 2>>"$BACKUP_DIR/.pgstate.err") || {
  echo "ERROR: state sidecar migration capture failed — see $BACKUP_DIR/.pgstate.err" >&2
  touch "$FAILURE_MARKER"
  notify_backup_failed "Postgres backup failed" "state sidecar migration capture failed at $(date -Is)"
  exit 1
}
[ -n "$MIGS_RAW" ] || {
  echo "ERROR: no migrations recorded on the source database — refusing to back up the wrong DB" >&2
  touch "$FAILURE_MARKER"
  notify_backup_failed "Postgres backup failed" "state sidecar found no migrations at $(date -Is)"
  exit 1
}
TABLES_RAW=$(run_db_client psql -v ON_ERROR_STOP=1 -h "$DB_HOST" -p "$DB_PORT" \
  -U "$DB_USER" -d "$DB_NAME" \
  -tAc "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name" \
  2>>"$BACKUP_DIR/.pgstate.err") || {
  echo "ERROR: state sidecar table capture failed — see $BACKUP_DIR/.pgstate.err" >&2
  touch "$FAILURE_MARKER"
  notify_backup_failed "Postgres backup failed" "state sidecar table capture failed at $(date -Is)"
  exit 1
}
[ -n "$TABLES_RAW" ] || {
  echo "ERROR: no public tables recorded on the source database — refusing to back up the wrong DB" >&2
  touch "$FAILURE_MARKER"
  notify_backup_failed "Postgres backup failed" "state sidecar found no tables at $(date -Is)"
  exit 1
}

# Keep stderr for failure detection (no 2>/dev/null) — a failed pg_dump must
# not leave a silent half-written gzip on disk.
if run_db_client pg_dump -U "$DB_USER" -d "$DB_NAME" -h "$DB_HOST" -p "$DB_PORT" \
  --no-owner 2>"$BACKUP_DIR/.pgdump.err" | gzip > "$TMP"; then
  if ! gzip -t "$TMP" 2>/dev/null || [ ! -s "$TMP" ]; then
    echo "ERROR: gzip validation failed for $TMP — backup discarded" >&2
    rm -f "$TMP"
    touch "$FAILURE_MARKER"
    notify_backup_failed "Postgres backup failed" "gzip validation failed at $(date -Is)"
    exit 1
  fi

  # Roles/tablespace globals are captured alongside the logical dump (#865) —
  # the restore verifier needs them to rebuild users before schema restore.
  GLOBALS_OUT="$BACKUP_DIR/${DB_NAME}-${STAMP}.globals.sql.gz.gpg"
  GLOBALS_TMP="$GLOBALS_OUT.tmp"
  GLOBALS_GPG_TMP="$GLOBALS_OUT.gpg.tmp"
  if ! run_db_client pg_dumpall -U "$DB_USER" -h "$DB_HOST" -p "$DB_PORT" \
      --globals-only 2>"$BACKUP_DIR/.pgdumpall.err" | gzip > "$GLOBALS_TMP" \
    || ! gzip -t "$GLOBALS_TMP" 2>/dev/null || [ ! -s "$GLOBALS_TMP" ]; then
    echo "ERROR: globals capture (pg_dumpall) failed — see $BACKUP_DIR/.pgdumpall.err" >&2
    rm -f "$GLOBALS_TMP"
    touch "$FAILURE_MARKER"
    notify_backup_failed "Postgres backup failed" "pg_dumpall globals capture failed at $(date -Is)"
    exit 1
  fi

  # State sidecar JSON (schema only — names/counts, no PII) is encrypted with
  # the same key and travels with the dump pair (#879).
  STATE_JSON_CONTENT=$(printf '{"sidecar_version": 1, "captured_at": "%s", "migrations": %s, "tables": %s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "$(printf '%s\n' "$MIGS_RAW" | json_lines_to_array)" \
    "$(printf '%s\n' "$TABLES_RAW" | json_lines_to_array)")
  printf '%s' "$STATE_JSON_CONTENT" | gzip > "$STATE_TMP"
  if ! gzip -t "$STATE_TMP" 2>/dev/null || [ ! -s "$STATE_TMP" ]; then
    echo "ERROR: state sidecar gzip validation failed — backup discarded" >&2
    rm -f "$TMP" "$GLOBALS_TMP" "$STATE_TMP"
    touch "$FAILURE_MARKER"
    notify_backup_failed "Postgres backup failed" "state sidecar gzip validation failed at $(date -Is)"
    exit 1
  fi

  # Encrypt at rest with GPG symmetric AES-256 (#185). The passphrase is
  # handed over fd 3 — never in argv (#865; argv is visible in ps output).
  if ! gpg --batch --yes --symmetric --cipher-algo AES256 \
      --passphrase-fd 3 --output "$GPG_TMP" 3< "$PASSPHRASE_FD_FILE" "$TMP" \
    || [ ! -s "$GPG_TMP" ]; then
    echo "ERROR: GPG encryption failed — see stderr" >&2
    rm -f "$TMP" "$GLOBALS_TMP" "$STATE_TMP" "$GPG_TMP"
    touch "$FAILURE_MARKER"
    notify_backup_failed "Postgres backup failed" "GPG encryption failed at $(date -Is)"
    exit 1
  fi
  if ! gpg --batch --yes --symmetric --cipher-algo AES256 \
      --passphrase-fd 3 --output "$GLOBALS_GPG_TMP" 3< "$PASSPHRASE_FD_FILE" "$GLOBALS_TMP" \
    || [ ! -s "$GLOBALS_GPG_TMP" ]; then
    echo "ERROR: GPG encryption failed for globals — see stderr" >&2
    rm -f "$TMP" "$GLOBALS_TMP" "$STATE_TMP" "$GPG_TMP" "$GLOBALS_GPG_TMP"
    touch "$FAILURE_MARKER"
    notify_backup_failed "Postgres backup failed" "globals GPG encryption failed at $(date -Is)"
    exit 1
  fi
  if ! gpg --batch --yes --symmetric --cipher-algo AES256 \
      --passphrase-fd 3 --output "$STATE_GPG_TMP" 3< "$PASSPHRASE_FD_FILE" "$STATE_TMP" \
    || [ ! -s "$STATE_GPG_TMP" ]; then
    echo "ERROR: GPG encryption failed for state sidecar — see stderr" >&2
    rm -f "$TMP" "$GLOBALS_TMP" "$STATE_TMP" "$GPG_TMP" "$GLOBALS_GPG_TMP" "$STATE_GPG_TMP"
    touch "$FAILURE_MARKER"
    notify_backup_failed "Postgres backup failed" "state sidecar GPG encryption failed at $(date -Is)"
    exit 1
  fi
  mv "$GPG_TMP" "$OUT"
  mv "$GLOBALS_GPG_TMP" "$GLOBALS_OUT"
  mv "$STATE_GPG_TMP" "$STATE_OUT"
  rm -f "$TMP" "$GLOBALS_TMP" "$STATE_TMP"
  rm -f "$FAILURE_MARKER"
  date +%s > "$SUCCESS_MARKER"
  resolve_backup
  echo "Backup written: $OUT ($(du -h "$OUT" | cut -f1))"
  echo "Globals written: $GLOBALS_OUT ($(du -h "$GLOBALS_OUT" | cut -f1))"
  echo "State sidecar written: $STATE_OUT ($(du -h "$STATE_OUT" | cut -f1))"
else
  echo "ERROR: pg_dump failed — see $BACKUP_DIR/.pgdump.err" >&2
  rm -f "$TMP"
  touch "$FAILURE_MARKER"
  notify_backup_failed "Postgres backup failed" "pg_dump failed at $(date -Is); see $BACKUP_DIR/.pgdump.err"
  exit 1
fi

find "$BACKUP_DIR" -name "${DB_NAME}-*.sql.gz.gpg" -mtime +"$KEEP_DAYS" -delete
find "$BACKUP_DIR" -name "${DB_NAME}-*.globals.sql.gz.gpg" -mtime +"$KEEP_DAYS" -delete
find "$BACKUP_DIR" -name "${DB_NAME}-*.state.json.gz.gpg" -mtime +"$KEEP_DAYS" -delete
find "$BACKUP_DIR" -name "${DB_NAME}-*.sql.gz" -mtime +"$KEEP_DAYS" -delete
echo "Old backups (older than ${KEEP_DAYS}d) pruned"

if [ -f "$FAILURE_MARKER" ]; then
  echo "WARN: previous backup run failed (marker present) — check backups" >&2
fi
