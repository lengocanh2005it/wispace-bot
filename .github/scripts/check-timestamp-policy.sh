#!/usr/bin/env bash
# Timestamp policy check (#1227): a new entity timestamp column is declared
# through the shared column-type constants in @wispace/contracts (ADR-0050), not
# as a bare literal. Bare literals in TypeORM decorators and TypeORM's own
# create/update date decorators and column defaults are all database-clock or
# framework-native and stay allowed.
#
# Diff-based on purpose: the repository already carries 96 bare `timestamptz`
# columns. A whole-repo scan would fail on all of them and force a rewrite,
# which this policy explicitly does not ask for. Only files changed against a
# base ref are inspected, so there is no legacy allowlist to maintain.
#
# Deliberately NOT covered:
#   - raw SQL (hundreds of `now()` call sites, all correct for their category)
#   - `type: 'timestamp'` (naive wall-clock; only 3 sites, not a new-column guide)
#   - `default: () => 'now()'` (database clock, correct for audit columns)
#   - `@CreateDateColumn` / `@UpdateDateColumn` (TypeORM's own convention)
#
# Usage: bash .github/scripts/check-timestamp-policy.sh [base-ref] [root]
set -euo pipefail

BASE_REF="${1:-}"
ROOT="${2:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$ROOT"

if [[ -z "$BASE_REF" ]]; then
  BASE_REF=$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)
  BASE_REF="${BASE_REF:-origin/main}"
fi

if ! git rev-parse --verify --quiet "$BASE_REF^{commit}" >/dev/null; then
  echo "ERROR: Base ref does not resolve to a commit: $BASE_REF" >&2
  exit 1
fi

MERGE_BASE=$(git merge-base "$BASE_REF" HEAD)
if [[ -z "$MERGE_BASE" ]]; then
  echo "ERROR: No merge base between $BASE_REF and HEAD" >&2
  exit 1
fi

FAILED=0
fail() { # message
  echo "FAIL: $1" >&2
  FAILED=1
}

# Added lines only, never whole files: touching a legacy entity to add one
# column must not force the caller to migrate the literals already there.
while IFS= read -r added; do
  [[ -n "$added" ]] || continue
  case "$added" in
    # TypeORM's create/update date decorators are the framework's own convention
    # for the database clock, and a bare database-clock default is the same
    # decision. Neither is what this policy guides.
    *'@CreateDateColumn'* | *'@UpdateDateColumn'* | *'default:'*) continue ;;
  esac
  fail "new bare timestamp column type: $added"
  echo '  declare the column type with TIMESTAMPTZ or DATE from @wispace/contracts (ADR-0050)' >&2
done <<<"$(git diff --unified=0 --diff-filter=ACMR "$MERGE_BASE" -- \
  '*.entity.ts' '*.entity.tsx' \
  | grep -E "^\+[^+].*type:[[:space:]]*'(timestamptz|date)'" || true)"

if [[ "$FAILED" -ne 0 ]]; then
  echo >&2
  echo 'Timestamp column types are owned by @wispace/contracts (ADR-0050):' >&2
  echo '  TIMESTAMPTZ — a timezone-aware instant' >&2
  echo '  DATE       — a learner-facing calendar day' >&2
  echo 'Existing bare literals are grandfathered; only changed files are checked.' >&2
  exit 1
fi
echo 'ok: no changed entity files declare a bare timestamp column type'
