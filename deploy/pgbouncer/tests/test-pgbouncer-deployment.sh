#!/bin/bash
# Validate PgBouncer deployment configuration.
# Run from repo root: bash deploy/pgbouncer/tests/test-pgbouncer-deployment.sh
set -euo pipefail

PASS=0
FAIL=0

assert_contains() {
  local file="$1" pattern="$2" label="$3"
  if grep -qE "$pattern" "$file"; then
    echo "  ✓ $label"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $label (pattern: $pattern)"
    FAIL=$((FAIL + 1))
  fi
}

assert_not_contains() {
  local file="$1" pattern="$2" label="$3"
  if grep -qE "$pattern" "$file"; then
    echo "  ✗ $label (pattern $pattern found)"
    FAIL=$((FAIL + 1))
  else
    echo "  ✓ $label"
    PASS=$((PASS + 1))
  fi
}

COMPOSE="deploy/docker-compose.pgbouncer.yml"
ENTRYPOINT="deploy/pgbouncer/entrypoint.sh"

echo "═══ PgBouncer deployment validation ═══"
echo ""

echo "─── Image pinning ───"
assert_contains "$COMPOSE" "@sha256:" "Image pinned by immutable digest"
assert_not_contains "$COMPOSE" "image:.*[^@]$" "No mutable-only image tags"
echo ""

echo "─── Container hardening ───"
assert_contains "$COMPOSE" "cap_drop" "cap_drop present"
assert_contains "$COMPOSE" "ALL" "All capabilities dropped"
assert_contains "$COMPOSE" "no-new-privileges" "no-new-privileges enabled"
assert_contains "$COMPOSE" "read_only" "Read-only root filesystem"
assert_contains "$COMPOSE" "tmpfs" "tmpfs for writable dirs"
assert_contains "$COMPOSE" "pids_limit" "PID limit set"
assert_contains "$COMPOSE" "mem_limit" "Memory limit set"
echo ""

echo "─── Credential validation ───"
assert_contains "$ENTRYPOINT" "DB_USER" "Validates DB_USER"
assert_contains "$ENTRYPOINT" "DB_PASSWORD" "Validates DB_PASSWORD"
assert_contains "$ENTRYPOINT" "DB_HOST" "Validates DB_HOST"
assert_contains "$ENTRYPOINT" "exit 1" "Fails closed on missing credentials"
echo ""

echo "─── Pool mode ───"
assert_contains "$COMPOSE" "POOL_MODE: session" "Session pool mode (required for advisory locks)"
echo ""

echo "─── Health check ───"
assert_contains "$COMPOSE" "pg_isready" "Health check present"
echo ""

echo "─── Port binding ───"
assert_contains "$COMPOSE" "127.0.0.1:" "Loopback-only host exposure"
echo ""

echo "═══ Results: $PASS passed, $FAIL failed ═══"
[ "$FAIL" -eq 0 ] || exit 1
