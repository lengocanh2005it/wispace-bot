#!/usr/bin/env bash
set -euo pipefail

# Static contract tests for the Vault-only production delivery path (#654).
# Run: bash .github/scripts/tests/vault-only-deploy.test.sh

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
WORKFLOW="$ROOT/.github/workflows/deploy-bot-reusable.yml"
DEPLOY_BOTS="$ROOT/.github/workflows/deploy-bots.yml"
SYNC_ENV="$ROOT/.github/workflows/sync-env.yml"
VPS_DEPLOY="$ROOT/.github/scripts/vps-deploy.sh"
SELF_PULL="$ROOT/.github/scripts/vps-self-pull-deploy.sh"
MIGRATION_RUNNER="$ROOT/apps/messenger-bot/src/infrastructure/database/vault-migrations.ts"
SECRET_MANAGER_GUARD="$ROOT/.github/scripts/check-secret-manager-references.sh"

fail() { echo "FAIL: $1" >&2; exit 1; }
pass() { echo "  ok: $1"; }

for file in "$WORKFLOW" "$DEPLOY_BOTS" "$SYNC_ENV"; do
  ! grep -Eq 'dopplerhq/cli-action|DOPPLER_TOKEN|cp +production\.env|> *production\.env' "$file" \
    || fail "$file still contains legacy Doppler/full-env delivery"
done
pass "workflows contain no Doppler/full production env delivery"

grep -q 'vault_role_id' "$WORKFLOW" || fail "reusable workflow lacks Vault role secret"
grep -q 'vault_secret_id' "$WORKFLOW" || fail "reusable workflow lacks Vault secret secret"
grep -q 'VAULT_REQUIRED=true' "$WORKFLOW" || fail "workflow does not create required Vault bootstrap"
grep -q 'vault-bootstrap\.env' "$WORKFLOW" || fail "workflow does not upload a bootstrap file"
for app in messenger discord zalo; do
  grep -q "VAULT_ROLE_ID_${app^^}" "$DEPLOY_BOTS" || fail "$DEPLOY_BOTS lacks ${app} AppRole mapping"
  grep -q "VAULT_ROLE_ID_${app^^}" "$SYNC_ENV" || fail "$SYNC_ENV lacks ${app} AppRole mapping"
done
pass "workflow declares the Vault bootstrap contract"

! grep -Eq 'production\.env|INTERNAL_API_KEY=.*\.env|DB_PASSWORD=.*\.env' "$VPS_DEPLOY" \
  || fail "VPS deploy still consumes full runtime secrets from env files"
grep -q 'vault-bootstrap\.env' "$VPS_DEPLOY" \
  || fail "VPS deploy does not install the Vault bootstrap file"
grep -q 'MIGRATION_PREFLIGHT_CMD' "$VPS_DEPLOY" \
  || fail "VPS deploy does not use the in-container migration preflight"
! grep -q '/proc/1/environ' "$VPS_DEPLOY" \
  || fail "VPS deploy reads runtime secrets from the process environment"
grep -q 'PGPASSWORD' "$MIGRATION_RUNNER" \
  || fail "Vault migration runner does not pass the DB password to pg_dump"
pass "VPS deploy consumes bootstrap-only env and in-container probes"

! grep -Eq 'production\.env' "$SELF_PULL" \
  || fail "self-pull still references the legacy runtime secret path"
grep -q 'validate_bootstrap_env' "$SELF_PULL" \
  || fail "self-pull does not validate the bootstrap env"
bash "$SECRET_MANAGER_GUARD" || fail "active legacy secret-manager reference detected"
pass "self-pull and tracked docs are Vault-only"

echo "ALL TESTS PASSED"
