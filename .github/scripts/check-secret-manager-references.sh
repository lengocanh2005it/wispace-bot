#!/usr/bin/env bash
set -euo pipefail

# CI guard for the retired secret-manager surface (#655). Tests and this guard
# may mention the migration name; the migration plan has one explicit history
# line. Everything else must use the Vault contract.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PATTERN='doppler|production\.env'
HISTORICAL_NOTE='Historical migration note (pre-#655): production delivery once used Doppler; current releases are Vault-only.'

violations=""
while IFS= read -r -d '' file; do
  [ -f "$ROOT/$file" ] || continue
  case "$file" in
    .github/scripts/check-secret-manager-references.sh|.github/scripts/tests/*|*.spec.ts|*.test.ts)
      continue
      ;;
  esac

  matches="$(rg -n -i -e "$PATTERN" -- "$ROOT/$file" || true)"
  if [ "$file" = "docs/turborepo-migration-plan.md" ]; then
    matches="$(printf '%s\n' "$matches" | grep -Fv -- "$HISTORICAL_NOTE" || true)"
  fi
  if [ -n "$matches" ]; then
    violations="${violations}${file}:\n${matches}\n"
  fi
done < <(cd "$ROOT" && git ls-files -z)

if [ -n "$violations" ]; then
  printf 'Active legacy secret-manager references found:\n%b' "$violations" >&2
  exit 1
fi

echo "No active legacy secret-manager references found"
