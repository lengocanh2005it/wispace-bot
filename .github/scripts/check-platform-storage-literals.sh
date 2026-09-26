#!/usr/bin/env bash
# Architectural check (#1079): per-platform storage metadata — mapping table,
# mapping key type, verify-intent table, verify-intent identifier column, and
# status column — has exactly one source: PLATFORM_STORAGE in
# @wispace/contracts (ADR-0042). A platform name may not be compared to choose
# a table, a column, or a status literal in the files that consume it, or the
# registry silently decays back into branches during an unrelated refactor.
#
# Deliberately NOT covered:
#   - canonical-platform.service.ts and learner-usage-query.ts keep literal
#     SQL; generating it from the registry would change the learner link-state
#     read path (ADR-0042).
#   - Redis key prefixes, privacy cleanup store sets, canonical platform
#     priority order, and advisory lock identifiers are a different concern.
#
# Usage: bash .github/scripts/check-platform-storage-literals.sh [root]
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$ROOT"

COVERED=(
  packages/database/src/services/metering-and-operations/privacy-data.service.ts
  packages/database/src/services/account-linking/platform-link-state.service.ts
  packages/study-reminder-shared/src/infrastructure/study-reminder-ownership.ts
  packages/study-reminder-shared/src/infrastructure/typeorm-study-reminder-job.repository.ts
)

# Table and column names that PLATFORM_STORAGE owns, plus a platform-name
# comparison — the shape every migrated branch had. A `?? 'messenger'`
# default is not a storage fact and is deliberately not matched.
STORAGE_LITERAL="user_platform_mappings|discord_account_links|zalo_account_links|_link_verify_records|'psid'|discord_user_id|zalo_user_id|(==|!=)= '(messenger|discord|zalo)'"

FAILED=0
fail() { # message
  echo "FAIL: $1" >&2
  FAILED=1
}

for f in "${COVERED[@]}"; do
  if [ ! -f "$f" ]; then
    fail "$f: covered file is missing; update COVERED in this guard"
    continue
  fi
  # <<< herestring, not a pipe: fail() must mutate FAILED in this shell
  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    fail "$f: platform storage literal is owned by PLATFORM_STORAGE (#1079): $hit"
  done <<<"$(grep -nE "$STORAGE_LITERAL" "$f" || true)"
done

if [ "$FAILED" -ne 0 ]; then
  echo >&2
  echo 'Read per-platform storage facts from PLATFORM_STORAGE in @wispace/contracts.' >&2
  echo 'Redis key prefixes, cleanup store sets, priority order and lock ids are out of' >&2
  echo 'scope and belong in their own registries.' >&2
  exit 1
fi
echo 'ok: no platform storage literals outside PLATFORM_STORAGE'
