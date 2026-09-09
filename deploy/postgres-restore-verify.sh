#!/usr/bin/env bash
set -euo pipefail

# Guarded, fail-closed restore verification for the encrypted nightly backup
# (#865, #879, parent #273). Replaces the unsafe copy-paste restore snippet.
#
# Modes:
#   --target disposable (default) — spawns its own short-lived PostgreSQL
#     container; the data lives only for this run and is removed afterwards.
#   --target staging — an explicitly given staging target which must match the
#     RESTORE_VERIFY_ALLOWLIST ("host[:port]:db,host[:port]:db,..."), resolve
#     away from any production IP (getent ahostsv4, #879), require TLS
#     (sslmode=verify-full + RESTORE_TARGET_CA), and be fresh/empty.
# The production DB_HOST/DB_NAME from the operator .env are read only to be
# rejected as targets, never used as defaults.
#
# Data integrity (#879): --state-artifact (backup-time migration/table
# inventory, captured before pg_dump) is REQUIRED. The restored database must
# contain every migration and table recorded in the sidecar — an empty or
# partial restore fails. Extra restored entries only warn (a deploy may have
# landed between sidecar capture and dump snapshot). RESTORE_VERIFY_MIN_ROWS
# ("table:count,...", default user_platform_mappings:1) enforces non-PII row
# floors. The expected state is never derived from the restored database.
#
# Globals: production globals are restored whole only into the disposable
# container. Staging receives a sanitized copy — roles outside the allowlist
# (target user, postgres, RESTORE_TARGET_ROLES) are dropped; PASSWORD,
# SUPERUSER, REPLICATION, CREATEROLE and ACL statements are stripped (#879).
#
# Secrets: the passphrase travels over a file descriptor (GPG --passphrase-fd),
# never in argv, never in logs, never in the evidence JSON.
# Evidence: one collision-resistant JSON file per run under --evidence-dir
# (random hex suffix, #879), pruned after
# RESTORE_VERIFY_EVIDENCE_RETENTION_DAYS (default 30). No learner text.
#
# Install on the VPS:
#   cp deploy/postgres-restore-verify.sh /home/ngoc_anh/scripts/
#   chmod +x /home/ngoc_anh/scripts/postgres-restore-verify.sh

usage() {
  cat >&2 <<'USAGE'
Usage: postgres-restore-verify.sh --artifact FILE --globals-artifact FILE \
  --state-artifact FILE --passphrase-file ENV_FILE [--passphrase-var NAME] \
  --env-file ENV_FILE --evidence-dir DIR [--target disposable|staging] \
  [--target-host H --target-port P --target-db D --target-user U] \
  [--postgres-image IMAGE] [--keep-container]
Env: RESTORE_VERIFY_ALLOWLIST, RESTORE_TARGET_PASSWORD, RESTORE_TARGET_CA,
     RESTORE_TARGET_ROLES, RESTORE_VERIFY_MIN_ROWS,
     RESTORE_VERIFY_EVIDENCE_RETENTION_DAYS
USAGE
  exit 2
}

ARTIFACT=""
GLOBALS_ARTIFACT=""
STATE_ARTIFACT=""
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
EVIDENCE_RETENTION_DAYS="${RESTORE_VERIFY_EVIDENCE_RETENTION_DAYS:-30}"

while [ $# -gt 0 ]; do
  case "$1" in
    --artifact) ARTIFACT="$2"; shift 2 ;;
    --globals-artifact) GLOBALS_ARTIFACT="$2"; shift 2 ;;
    --state-artifact) STATE_ARTIFACT="$2"; shift 2 ;;
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
[ -n "$STATE_ARTIFACT" ] || usage
[ -n "$ENV_FILE" ] || usage
[ -n "$EVIDENCE_DIR" ] || usage

START_TS=$(date +%s)
RUN_ID=$(date +%Y%m%d-%H%M%S)
RUN_HEX=$(od -An -N4 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')
[ -n "$RUN_HEX" ] || RUN_HEX="$$"
EVIDENCE_FILE="$EVIDENCE_DIR/restore-verify-$RUN_ID-$RUN_HEX.json"
WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/restore-verify.XXXXXX")
DUMP_SQL="$WORK_DIR/dump.sql"
GLOBALS_SQL="$WORK_DIR/globals.sql"
GLOBALS_FILTERED_SQL="$WORK_DIR/globals.filtered.sql"
STATE_JSON="$WORK_DIR/state.json"
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
  "state_sha256": "${STATE_SHA256:-}",
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
  # Evidence retention (#879): prune old runs on every exit.
  if [ -n "${EVIDENCE_DIR:-}" ] && [ "$EVIDENCE_RETENTION_DAYS" -gt 0 ] 2>/dev/null; then
    find "$EVIDENCE_DIR" -name 'restore-verify-*.json' -type f \
      -mtime +"$EVIDENCE_RETENTION_DAYS" -delete 2>/dev/null || true
  fi
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT INT TERM

require_file() { [ -s "$1" ] || die "missing or empty file: $2"; }

env_value() { # NAME FILE
  grep -E "^$1=" "$2" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'"
}

# Extract one JSON array from the sidecar as newline-separated entries. The
# sidecar shape is machine-generated by postgres-backup.sh — never free-form.
json_array() { # FILE KEY
  grep -o "\"$2\"[[:space:]]*:[[:space:]]*\[[^]]*\]" "$1" \
    | sed 's/.*\[//; s/\]//' \
    | tr ',' '\n' | tr -d '" ' | grep -v '^$' || true
}

# Read production identity from the operator env — ONLY to reject it as a
# target. Never used as a connection default.
PROD_DB_HOST=$(env_value DB_HOST "$ENV_FILE")
PROD_DB_NAME=$(env_value DB_NAME "$ENV_FILE")

# ---------------------------------------------------------------------------
# Argument validation (fail closed before any secret or network use)
# The evidence dir exists before any validation die() so every early failure
# still writes evidence (#879).
# ---------------------------------------------------------------------------
mkdir -p "$EVIDENCE_DIR"
chmod 700 "$EVIDENCE_DIR" 2>/dev/null || true
require_file "$ARTIFACT" "artifact"
require_file "$GLOBALS_ARTIFACT" "globals artifact"
require_file "$STATE_ARTIFACT" "state artifact"
[ -f "$ENV_FILE" ] || die "missing env file: $ENV_FILE"
[ -f "$PASSPHRASE_FILE" ] || die "missing passphrase file: $PASSPHRASE_FILE"

for f in "$ARTIFACT" "$GLOBALS_ARTIFACT" "$STATE_ARTIFACT"; do
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
    # TLS is mandatory for a remote staging target (#879).
    [ -n "${RESTORE_TARGET_CA:-}" ] || die "staging target requires RESTORE_TARGET_CA (TLS CA bundle)"
    [ -f "$RESTORE_TARGET_CA" ] || die "RESTORE_TARGET_CA file not found: $RESTORE_TARGET_CA"
    # Anti-alias (#879): the staging host must not resolve into production.
    command -v getent >/dev/null || die "getent is required for staging target isolation"
    resolve_ips() { getent ahostsv4 "$1" 2>/dev/null | awk '{print $1}' | sort -u; }
    stag_ips=$(resolve_ips "$TARGET_HOST" || true)
    [ -n "$stag_ips" ] || die "staging host did not resolve (ambiguous or unknown target)"
    if [ -n "$PROD_DB_HOST" ]; then
      prod_ips=$(resolve_ips "$PROD_DB_HOST" || true)
      if [ -n "$prod_ips" ]; then
        # ponytail: IP-set intersection only — CNAME chains through a prod
        # hostname need dig+trace; add if DNS topology ever demands it.
        common_ips=$(comm -12 <(printf '%s\n' "$stag_ips") <(printf '%s\n' "$prod_ips"))
        if [ -n "$common_ips" ]; then
          die "refusing to restore: staging host resolves to a production IP"
        fi
      fi
    fi
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
decrypt_to "$STATE_ARTIFACT" "$STATE_JSON.gz"
gzip -t "$GLOBALS_SQL.gz" || die "globals archive is not a complete gzip"
gzip -t "$DUMP_SQL.gz" || die "dump archive is not a complete gzip (truncated backup?)"
gzip -t "$STATE_JSON.gz" || die "state sidecar archive is not a complete gzip"
gzip -dc "$GLOBALS_SQL.gz" > "$GLOBALS_SQL"
gzip -dc "$DUMP_SQL.gz" > "$DUMP_SQL"
gzip -dc "$STATE_JSON.gz" > "$STATE_JSON"
[ -s "$GLOBALS_SQL" ] || die "decrypted globals dump is empty"
[ -s "$DUMP_SQL" ] || die "decrypted dump is empty"
[ -s "$STATE_JSON" ] || die "decrypted state sidecar is empty"
sidecar_version=$(grep -o '"sidecar_version"[[:space:]]*:[[:space:]]*[0-9]*' "$STATE_JSON" \
  | grep -o '[0-9]*$' || true)
[ "$sidecar_version" = "1" ] || die "state sidecar has an unsupported version (${sidecar_version:-missing}) — expectation is unusable"
ARTIFACT_SHA256=$(sha256sum "$ARTIFACT" | cut -d' ' -f1)
GLOBALS_SHA256=$(sha256sum "$GLOBALS_ARTIFACT" | cut -d' ' -f1)
STATE_SHA256=$(sha256sum "$STATE_ARTIFACT" | cut -d' ' -f1)
log "archives decrypted and gzip-validated"

# ---------------------------------------------------------------------------
# Stage 2 — target database (disposable container or allowlisted staging)
# ---------------------------------------------------------------------------
if [ "$TARGET" = "staging" ]; then
  export PGSSLMODE=verify-full
  export PGSSLROOTCERT="$RESTORE_TARGET_CA"
fi

PSQL() { # db <psql args...>
  local db="$1"; shift
  PGPASSWORD="$PGPASSWORD_VALUE" psql -v ON_ERROR_STOP=1 \
    -h "$TARGET_HOST_ACTUAL" -p "$TARGET_PORT_ACTUAL" \
    -U "$TARGET_USER_ACTUAL" -d "$db" "$@"
}

run_check() { # name status [detail]
  CHECKS_JSON="$CHECKS_JSON{\"name\": \"$1\", \"status\": \"$2\"}, "
  if [ "$2" = "pass" ]; then log "check $1: pass"
  elif [ "$2" = "warn" ]; then log "check $1: WARN — ${3:-}"
  else log "check $1: FAIL — ${3:-}"; fi
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
  # Fresh-empty staging target (#879): create if missing, refuse if non-empty.
  db_exists=$(PSQL postgres -tAc \
    "SELECT 1 FROM pg_database WHERE datname='$TARGET_DB_ACTUAL'") \
    || die "staging target preflight failed (unreachable or auth error)"
  if [ "$db_exists" != "1" ]; then
    PSQL postgres -c "CREATE DATABASE \"$TARGET_DB_ACTUAL\"" >/dev/null \
      || die "could not create the staging database"
    log "staging database created fresh"
  fi
  pre_tables=$(PSQL "$TARGET_DB_ACTUAL" -tAc \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'") \
    || die "staging emptiness check failed"
  [ "$pre_tables" -eq 0 ] || die "staging target is not empty (public tables=$pre_tables) — refusing to restore over existing data"
  run_check staging_fresh pass "pre_tables=$pre_tables"
fi

# ---------------------------------------------------------------------------
# Stage 3 — restore globals (roles) then schema/data
# ---------------------------------------------------------------------------
if [ "$TARGET" = "staging" ]; then
  # Sanitize production globals (#879): allowlisted roles only, no passwords,
  # no superuser/replication/createrole, no ACL statements. The staging login
  # (and postgres) already exist, so CREATE ROLE is only emitted for roles
  # missing on the target — ON_ERROR_STOP would otherwise abort the restore.
  # ALTER ROLE is rewritten to a fixed safe attribute set, never verbatim.
  existing_roles=$(PSQL postgres -tAc "SELECT rolname FROM pg_roles" | sort -u) \
    || die "staging role inventory query failed"
  existing_comma=$(printf '%s\n' "$existing_roles" | paste -sd, - 2>/dev/null || echo "")
  awk -v allow="$TARGET_USER_ACTUAL,postgres,${RESTORE_TARGET_ROLES:-}" -v existing="$existing_comma" '
    BEGIN {
      n = split(allow, a, ","); for (i = 1; i <= n; i++) if (a[i] != "") allowed[a[i]] = 1
      m = split(existing, e, ","); for (i = 1; i <= m; i++) if (e[i] != "") exists[e[i]] = 1
    }
    /^[[:space:]]*CREATE ROLE/ {
      line = $0; name = ""
      if (match(line, /"[^"]+"/)) name = substr(line, RSTART + 1, RLENGTH - 2)
      else if (match(line, /CREATE ROLE[[:space:]]+[^ ;]+/)) {
        name = substr(line, RSTART, RLENGTH)
        sub(/.*CREATE ROLE[[:space:]]+/, "", name)
      }
      if (!(name in allowed) || (name in exists)) next
      print "CREATE ROLE \"" name "\" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;"
      next
    }
    /^[[:space:]]*ALTER ROLE/ {
      if ($0 ~ /PASSWORD/) next
      line = $0; name = ""
      if (match(line, /"[^"]+"/)) name = substr(line, RSTART + 1, RLENGTH - 2)
      else if (match(line, /ALTER ROLE[[:space:]]+[^ ;]+/)) {
        name = substr(line, RSTART, RLENGTH)
        sub(/.*ALTER ROLE[[:space:]]+/, "", name)
      }
      if (!(name in allowed)) next
      print "ALTER ROLE \"" name "\" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;"
      next
    }
    /^[[:space:]]*(GRANT|REVOKE|ALTER DEFAULT PRIVILEGES|COMMENT ON ROLE)[[:space:]]/ { next }
    { print }
  ' "$GLOBALS_SQL" > "$GLOBALS_FILTERED_SQL"
  GLOBALS_TO_RESTORE="$GLOBALS_FILTERED_SQL"
else
  GLOBALS_TO_RESTORE="$GLOBALS_SQL"
fi

PSQL postgres -f "$GLOBALS_TO_RESTORE" >/dev/null \
  || die "restoring globals (roles) failed"
run_check globals pass

PSQL postgres -c "CREATE DATABASE \"$TARGET_DB_ACTUAL\"" >/dev/null 2>&1 || true
PSQL "$TARGET_DB_ACTUAL" -f "$DUMP_SQL" >/dev/null \
  || die "restoring schema/data failed"
run_check restore pass

# ---------------------------------------------------------------------------
# Stage 4 — versioned state expectation + non-PII row floors (#879)
# The expected set comes ONLY from the backup-time sidecar, never from the
# restored database itself.
# ---------------------------------------------------------------------------
sidecar_version=$(grep -o '"sidecar_version"[[:space:]]*:[[:space:]]*[0-9]*' "$STATE_JSON" \
  | grep -o '[0-9]*$' || true)
[ "$sidecar_version" = "1" ] || die "state sidecar has an unsupported version (${sidecar_version:-missing}) — expectation is unusable"
sidecar_migrations=$(json_array "$STATE_JSON" migrations | sort)
sidecar_tables=$(json_array "$STATE_JSON" tables | sort)
[ -n "$sidecar_migrations" ] || die "state sidecar records no migrations — unusable expectation"
[ -n "$sidecar_tables" ] || die "state sidecar records no tables — unusable expectation"

restored_migrations=$(PSQL "$TARGET_DB_ACTUAL" -tAc \
  "SELECT name FROM public.migrations ORDER BY name" | sort) \
  || die "migration state query failed — restore incomplete"
restored_tables=$(PSQL "$TARGET_DB_ACTUAL" -tAc \
  "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name" | sort) \
  || die "table inventory query failed — restore incomplete"

missing_migs=$(comm -23 <(printf '%s\n' "$sidecar_migrations") <(printf '%s\n' "$restored_migrations"))
[ -z "$missing_migs" ] || die "restored migrations are missing sidecar entries: $(printf '%s ' $missing_migs)"
run_check state_migrations pass "count=$(printf '%s\n' "$restored_migrations" | grep -c .)"

extra_migs=$(comm -13 <(printf '%s\n' "$sidecar_migrations") <(printf '%s\n' "$restored_migrations") | grep . || true)
if [ -n "$extra_migs" ]; then
  run_check state_migrations warn "extra restored migrations: $(printf '%s ' $extra_migs)"
fi

missing_tables=$(comm -23 <(printf '%s\n' "$sidecar_tables") <(printf '%s\n' "$restored_tables"))
[ -z "$missing_tables" ] || die "restored tables are missing sidecar entries: $(printf '%s ' $missing_tables)"
run_check state_tables pass "count=$(printf '%s\n' "$restored_tables" | grep -c .)"

extra_tables=$(comm -13 <(printf '%s\n' "$sidecar_tables") <(printf '%s\n' "$restored_tables") | grep . || true)
if [ -n "$extra_tables" ]; then
  run_check state_tables warn "extra restored tables: $(printf '%s ' $extra_tables)"
fi

# Non-PII row floors: a structurally valid restore of the wrong/empty data
# still fails here. Counts only — no learner text is ever read out.
MIN_ROWS_DEFAULT="user_platform_mappings:1"
IFS=',' read -ra MINROW_ENTRIES <<< "${RESTORE_VERIFY_MIN_ROWS:-$MIN_ROWS_DEFAULT}"
for entry in "${MINROW_ENTRIES[@]}"; do
  [ -n "$entry" ] || continue
  tbl="${entry%%:*}"
  floor="${entry##*:}"
  case "$tbl" in *[!A-Za-z0-9_]*|'') die "invalid table name in RESTORE_VERIFY_MIN_ROWS: $tbl" ;; esac
  case "$floor" in ''|*[!0-9]*) die "invalid row floor in RESTORE_VERIFY_MIN_ROWS: $entry" ;; esac
  rows=$(PSQL "$TARGET_DB_ACTUAL" -tAc "SELECT count(*) FROM public.$tbl") \
    || die "row floor query failed for $tbl — restore incomplete"
  [ "$rows" -ge "$floor" ] \
    || die "row floor violated for $tbl: got $rows, expected >= $floor (empty or partial restore?)"
done
run_check min_rows pass "entries=${#MINROW_ENTRIES[@]}"

# ---------------------------------------------------------------------------
# Evidence + completion
# ---------------------------------------------------------------------------
if [ "$TARGET" = "disposable" ] && [ "$KEEP_CONTAINER" -ne 1 ]; then
  docker rm -f "$CONTAINER_NAME" >/dev/null || die "failed to remove the disposable container"
fi

write_evidence success "restore verified"
log "restore verification PASSED ($(($(date +%s) - START_TS)) s) — evidence: $EVIDENCE_FILE"
