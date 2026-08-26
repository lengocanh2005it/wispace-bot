#!/bin/sh
set -eu

# PgBouncer entrypoint — validates required credentials, generates config,
# then execs the image's default entrypoint (which renders pgbouncer.ini
# and userlist.txt from environment variables).

# ── Credential validation (fail-closed) ──────────────────────────────────
if [ -z "${DB_USER:-}" ] || [ -z "${DB_PASSWORD:-}" ]; then
  echo "FATAL: DB_USER and DB_PASSWORD must be set" >&2
  exit 1
fi

if [ -z "${DB_HOST:-}" ]; then
  echo "FATAL: DB_HOST must be set" >&2
  exit 1
fi

# ── Hand off to image entrypoint ─────────────────────────────────────────
# The edoburu/pgbouncer image entrypoint generates pgbouncer.ini and
# userlist.txt from the environment, then execs pgbouncer.
exec /entrypoint.sh "$@"
