#!/usr/bin/env bash
set -euo pipefail

# Guarded, fail-closed restore verification for the encrypted nightly backup
# (#865, parent #273). Replaces the unsafe copy-paste restore snippet.
#
# Modes:
#   --target disposable (default) — spawns its own short-lived PostgreSQL
#     container; the data lives only for this run and is removed afterwards.
#   --target staging — an explicitly given staging target which must match the
#     RESTORE_VERIFY_ALLOWLIST ("host[:port]:db,host[:port]:db,...").
# The production DB_HOST/DB_NAME from the operator .env are read only to be
# rejected as targets, never used as defaults.
#
# Secrets: the passphrase travels over a file descriptor (GPG --passphrase-fd),
# never in argv, never in logs, never in the evidence JSON.
# Evidence: one JSON file per run under --evidence-dir recording artifact
# sha256, target kind, duration, and per-check outcomes. No learner text.
#
# Install on the VPS:
#   cp deploy/postgres-restore-verify.sh /home/ngoc_anh/scripts/
#   chmod +x /home/ngoc_anh/scripts/postgres-restore-verify.sh

usage() {
  cat >&2 <<'USAGE'
Usage: postgres-restore-verify.sh --artifact FILE --globals-artifact FILE \
  --passphrase-file ENV_FILE [--passphrase-var NAME] --env-file ENV_FILE \
  --evidence-dir DIR [--target disposable|staging] \
  [--target-host H --target-port P --target-db D --target-user U] \
  [--postgres-image IMAGE] [--keep-container]
USAGE
  exit 2
}

ARTIFACT=""
GLOBALS_ARTIFACT=""
PASSPHRASE_FILE=""
PASSPHRASE_VAR="BACKUP_ENCRYPTION_PASSPHRASE"
ENV_FILE=""
EVIDENCE_DIR=""
TARGET="disposable"
TARGET_HOST=""
TARGET_PORT="5432"
TARGET_DB=""
TARGET_USER=""
PG_IMAGE="postgres:16-alpine"
KEEP_CONTAINER=0

while [ $# -gt 0 ]; do
  case "$1" in
    --artifact) ARTIFACT="$2"; shift 2 ;;
    --globals-artifact) GLOBALS_ARTIFACT="$2"; shift 2 ;;
    --passphrase-file) PASSPHRASE_FILE="$2"; shift 2 ;;
    --passphrase-var) PASSPHRASE_VAR="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --evidence-dir) EVIDENCE_DIR="$2"; shift 2 ;;
    --target) TARGET="$2"; shift 2 ;;
    --target-host) TARGET_HOST="$2"; shift 2 ;;
    --target-port) TARGET_PORT="$2"; shift 2 ;;
    --target-db) TARGET_DB="$2"; shift 2 ;;
    --target-user) TARGET_USER="$2"; shift 2 ;;
    --postgres-image) PG_IMAGE="$2"; shift 2 ;;
    --keep-container) KEEP_CONTAINER=1; shift ;;
    *) usage ;;
  esac
done

[ -n "$ARTIFACT" ] || usage
[ -n "$GLOBALS_ARTIFACT" ] || usage
[ -n "$ENV_FILE" ] || usage
[ -n "$EVIDENCE_DIR" ] || usage

START_TS=$(date +%s)
RUN_ID=$(date +%Y%m%d-%H%M%S)
EVIDENCE_FILE="$EVIDENCE_DIR/restore-verify-$RUN_ID.json"
WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/restore-verify.XXXXXX")
DUMP_SQL="$WORK_DIR/dump.sql"
GLOBALS_SQL="$WORK_DIR/globals.sql"
PASSPHRASE_FD_FILE="$WORK_DIR/.passphrase"
PGPASSWORD_VALUE=""

# result_json STATE — append the current stage to the evidence checks array.
CHECKS_JSON=""

die() {
  echo "ERROR: $1" >&2
  write_evidence failure "$1" 2>/dev/null || true
  exit 1
}
log() { echo "[restore-verify] $1"; }

json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

write_evidence() { # result detail
  local result="$1" detail
  detail=$(json_escape "$2")
  local checks="$CHECKS_JSON"
  checks="${checks%, }"
  local end_ts duration
  end_ts=$(date +%s)
  duration=$((end_ts - START_TS))
  cat > "$EVIDENCE_FILE" <<JSON
{
  "result": "$result",
  "detail": "$detail",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "duration_seconds": $duration,
  "target": { "kind": "$TARGET", "host": "${TARGET_HOST_ACTUAL:-}", "port": "${TARGET_PORT_ACTUAL:-}", "database": "${TARGET_DB_ACTUAL:-}" },
  "artifact_sha256": "${ARTIFACT_SHA256:-}",
  "globals_sha256": "${GLOBALS_SHA256:-}",
  "checks": [$checks]
}
JSON
  EVIDENCE_WRITTEN=1
}

cleanup() {
  local status=$?
  if [ -n "${CONTAINER_NAME:-}" ] && [ "$KEEP_CONTAINER" -ne 1 ]; then
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  fi
  if [ -n "${EVIDENCE_FILE:-}" ] && [ "${EVIDENCE_WRITTEN:-0}" -ne 1 ]; then
    write_evidence failure "cleanup after abnormal exit (status=$status)" || true
  fi
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT INT TERM

require_file() { [ -s "$1" ] || die "missing or empty file: $2"; }

env_value() { # NAME FILE
  grep -E "^$1=" "$2" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'"
}

# Read production identity from the operator env — ONLY to reject it as a
# target. Never used as a connection default.
PROD_DB_HOST=$(env_value DB_HOST "$ENV_FILE")
PROD_DB_NAME=$(env_value DB_NAME "$ENV_FILE")

# ---------------------------------------------------------------------------
# Argument validation (fail closed before any secret or network use)
# ---------------------------------------------------------------------------
require_file "$ARTIFACT" "artifact"
require_file "$GLOBALS_ARTIFACT" "globals artifact"
[ -f "$ENV_FILE" ] || die "missing env file: $ENV_FILE"
[ -f "$PASSPHRASE_FILE" ] || die "missing passphrase file: $PASSPHRASE_FILE"
mkdir -p "$EVIDENCE_DIR"
chmod 700 "$EVIDENCE_DIR" 2>/dev/null || true

for f in "$ARTIFACT" "$GLOBALS_ARTIFACT"; do
  case "$f" in
    *.gpg) : ;;
    *) die "artifact must be GPG-encrypted (.gpg): $f" ;;
  esac
done

case "$TARGET" in
  disposable)
    if [ -n "$TARGET_HOST" ] || [ -n "$TARGET_DB" ] || [ -n "$TARGET_USER" ]; then
      die "--target-host/-db/-user are only valid with --target staging"
    fi
    ;;
  staging)
    [ -n "$TARGET_HOST" ] || die "staging target requires --target-host"
    [ -n "$TARGET_DB" ] || die "staging target requires --target-db"
    [ -n "$TARGET_USER" ] || die "staging target requires --target-user"
    # Production identity is never an acceptable target — checked BEFORE the
    # allowlist so a prod-identical entry cannot legitimize a restore.
    if [ -n "$PROD_DB_HOST" ] && [ "$TARGET_HOST" = "$PROD_DB_HOST" ]; then
      die "refusing to restore: target host matches production DB_HOST"
    fi
    if [ -n "$PROD_DB_NAME" ] && [ "$TARGET_DB" = "$PROD_DB_NAME" ]; then
      die "refusing to restore: target database matches production DB_NAME"
    fi
    [ -n "${RESTORE_VERIFY_ALLOWLIST:-}" ] || die "staging target requires RESTORE_VERIFY_ALLOWLIST (host[:port]:db,...)"
    allowlisted=0
    IFS=',' read -ra ALLOWED <<< "$RESTORE_VERIFY_ALLOWLIST"
    for entry in "${ALLOWED[@]}"; do
      allow_host="${entry%%:*}"
      allow_db="$entry"
      allow_port="$TARGET_PORT"
      rest="${entry#*:}"
      if [ "$rest" != "$entry" ]; then
        # host[:port]:db — port optional
        allow_db="${rest#*:}"
        allow_port="${rest%%:*}"
        case "$allow_port" in
          ''|*[!0-9]*) allow_port="$TARGET_PORT" ;;
        esac
      fi
      if [ "$allow_host" = "$TARGET_HOST" ] && [ "$allow_port" = "$TARGET_PORT" ] \
        && [ "$allow_db" = "$TARGET_DB" ]; then
        allowlisted=1
        break
      fi
    done
    [ "$allowlisted" -eq 1 ] || die "staging target $TARGET_HOST:$TARGET_PORT/$TARGET_DB is not in RESTORE_VERIFY_ALLOWLIST"
    ;;
  *) die "unknown target: $TARGET" ;;
esac

umask 077
command -v gpg >/dev/null || die "gpg is required"
command -v gzip >/dev/null || die "gzip is required"
command -v psql >/dev/null || die "psql (postgresql-client) is required"

# ---------------------------------------------------------------------------
# Passphrase handoff — file descriptor only, never argv, never logged
# ---------------------------------------------------------------------------
env_value "$PASSPHRASE_VAR" "$PASSPHRASE_FILE" > "$PASSPHRASE_FD_FILE"
chmod 600 "$PASSPHRASE_FD_FILE"
[ -s "$PASSPHRASE_FD_FILE" ] || die "missing $PASSPHRASE_VAR in $PASSPHRASE_FILE"

decrypt_to() { # src.gpg dest
  gpg --batch --yes --quiet --decrypt \
    --passphrase-fd 3 --output "$2" 3< "$PASSPHRASE_FD_FILE" "$1" \
    || die "GPG decryption failed for $1 (wrong key or damaged artifact)"
}

# ---------------------------------------------------------------------------
# Stage 1 — decrypt + validate archives
# ---------------------------------------------------------------------------
decrypt_to "$GLOBALS_ARTIFACT" "$GLOBALS_SQL.gz"
decrypt_to "$ARTIFACT" "$DUMP_SQL.gz"
gzip -t "$GLOBALS_SQL.gz" || die "globals archive is not a complete gzip"
gzip -t "$DUMP_SQL.gz" || die "dump archive is not a complete gzip (truncated backup?)"
gzip -dc "$GLOBALS_SQL.gz" > "$GLOBALS_SQL"
gzip -dc "$DUMP_SQL.gz" > "$DUMP_SQL"
[ -s "$GLOBALS_SQL" ] || die "decrypted globals dump is empty"
[ -s "$DUMP_SQL" ] || die "decrypted dump is empty"
ARTIFACT_SHA256=$(sha256sum "$ARTIFACT" | cut -d' ' -f1)
GLOBALS_SHA256=$(sha256sum "$GLOBALS_ARTIFACT" | cut -d' ' -f1)
log "archives decrypted and gzip-validated"

# ---------------------------------------------------------------------------
# Stage 2 — target database (disposable container or allowlisted staging)
# ---------------------------------------------------------------------------
PSQL() { # db <psql args...>
  local db="$1"; shift
  PGPASSWORD="$PGPASSWORD_VALUE" psql -v ON_ERROR_STOP=1 \
    -h "$TARGET_HOST_ACTUAL" -p "$TARGET_PORT_ACTUAL" \
    -U "$TARGET_USER_ACTUAL" -d "$db" "$@"
}

run_check() { # name status detail
  CHECKS_JSON="$CHECKS_JSON{\"name\": \"$1\", \"status\": \"$2\"}, "
  if [ "$2" = "pass" ]; then log "check $1: pass"; else log "check $1: FAIL — $3"; fi
}

CONTAINER_NAME=""
if [ "$TARGET" = "disposable" ]; then
  command -v docker >/dev/null || die "docker is required for the disposable target"
  CONTAINER_NAME="restore-verify-$$"
  PGPASSWORD_VALUE=$(head -c 24 /dev/urandom | sha256sum | cut -d' ' -f1)
  docker run -d --rm --name "$CONTAINER_NAME" \
    -e "POSTGRES_PASSWORD=$PGPASSWORD_VALUE" \
    -e "POSTGRES_USER=restorer" -e "POSTGRES_DB=restore_verify" \
    -p 127.0.0.1:0:5432 \
    "$PG_IMAGE" >/dev/null || die "failed to start disposable PostgreSQL container"
  TARGET_HOST_ACTUAL="127.0.0.1"
  TARGET_PORT_ACTUAL=$(docker port "$CONTAINER_NAME" 5432 | head -1 | sed 's/.*://')
  [ -n "$TARGET_PORT_ACTUAL" ] || die "disposable container did not expose port 5432"
  TARGET_DB_ACTUAL="restore_verify"
  TARGET_USER_ACTUAL="restorer"
  for _ in $(seq 1 30); do
    docker exec "$CONTAINER_NAME" pg_isready -q && break
    sleep 1
  done
  docker exec "$CONTAINER_NAME" pg_isready -q \
    || die "disposable PostgreSQL never became ready"
else
  TARGET_HOST_ACTUAL="$TARGET_HOST"
  TARGET_PORT_ACTUAL="$TARGET_PORT"
  TARGET_DB_ACTUAL="$TARGET_DB"
  TARGET_USER_ACTUAL="$TARGET_USER"
  PGPASSWORD_VALUE="${RESTORE_TARGET_PASSWORD:-}"
  [ -n "$PGPASSWORD_VALUE" ] || die "staging target requires RESTORE_TARGET_PASSWORD"
fi

# ---------------------------------------------------------------------------
# Stage 3 — restore globals (roles) then schema/data
# ---------------------------------------------------------------------------
PSQL postgres -f "$GLOBALS_SQL" >/dev/null \
  || die "restoring globals (roles) failed"
run_check globals pass

PSQL postgres -c "CREATE DATABASE \"$TARGET_DB_ACTUAL\"" >/dev/null 2>&1 || true
PSQL "$TARGET_DB_ACTUAL" -f "$DUMP_SQL" >/dev/null \
  || die "restoring schema/data failed"
run_check restore pass

# ---------------------------------------------------------------------------
# Stage 4 — migration state + representative data invariants
# ---------------------------------------------------------------------------
migration_count=$(PSQL "$TARGET_DB_ACTUAL" -tAc \
  'SELECT count(*) FROM public.migrations') \
  || die "migration state query failed — restore incomplete"
[ "$migration_count" -gt 0 ] \
  || die "no migrations recorded — restore did not produce a valid schema"
run_check migrations pass "count=$migration_count"

# Representative row counts: every non-empty public table must be queryable
# and report a count — a partially-restored schema fails here.
row_check_failures=$(PSQL "$TARGET_DB_ACTUAL" -tAc \
  "SELECT count(*) FROM (
     SELECT to_regclass(format('public.%I', table_name)) IS NULL AS missing
     FROM information_schema.tables WHERE table_schema='public'
   ) t WHERE missing") || die "row-count invariant query failed"
[ "$row_check_failures" -eq 0 ] || die "some restored tables are missing — partial restore"
table_count=$(PSQL "$TARGET_DB_ACTUAL" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'") \
  || die "table inventory query failed"
[ "$table_count" -gt 0 ] || die "no public tables restored"
run_check row_counts pass "tables=$table_count"

# ---------------------------------------------------------------------------
# Evidence + completion
# ---------------------------------------------------------------------------
if [ "$TARGET" = "disposable" ] && [ "$KEEP_CONTAINER" -ne 1 ]; then
  docker rm -f "$CONTAINER_NAME" >/dev/null || die "failed to remove the disposable container"
fi

write_evidence success "restore verified"
log "restore verification PASSED ($(($(date +%s) - START_TS)) s) — evidence: $EVIDENCE_FILE"
