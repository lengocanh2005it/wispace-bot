#!/usr/bin/env bash
# Architectural check (#1500): a PostgreSQL advisory-lock id is declared in a
# registry, not inline. `ADVISORY_LOCKS` in
# packages/bot-common/src/locks/advisory-lock-ids.ts is written as the single
# home for these ids, but seventeen were numeric literals in app modules, so the
# question "which advisory locks does this repository use, and who owns each one"
# could not be answered by reading the registry — only by grepping.
#
# That is the drift class #1160 was one instance of: 884_200_937 was declared
# inside a cron, so the registry could not see it, and a second divergence rode
# along unnoticed.
#
# Deliberately NOT covered:
#   - `packages/study-reminder-shared` keeps 884_200_901/902/903 hardcoded. A
#     shared package cannot import from an application, so it re-declares ids
#     Messenger's registry already owns — that is blocked by the layering rule,
#     not by carelessness. The fix is to inject the ids through the per-platform
#     lock-id parameters the reminder providers already take (#777), and it has
#     its own issue rather than an exemption here.
#   - Specs assert concrete values on purpose. A test that reads the id from the
#     registry proves nothing, so specs are excluded the way the other guards
#     exclude them.
#   - Messenger keeps its own registry by design (documented in the shared
#     registry's header). That file is an allowed home.
#
# Usage: bash .github/scripts/check-advisory-lock-literals.sh [root]
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$ROOT"

# 884_2xx_xxx is this repository's advisory-lock id space. A literal anywhere
# else is a declaration in the wrong place.
LOCK_LITERAL='884_2[0-9]{2}_[0-9]+'

REGISTRIES=(
  packages/bot-common/src/locks/advisory-lock-ids.ts
  apps/messenger-bot/src/shared/common/advisory-lock-ids.ts
)

# The one shared package that must re-declare its own ids, and why.
ALLOWED_NON_REGISTRY=(
  packages/study-reminder-shared/src/services/study-reminder-worker.service.ts
)

SCANNED=(apps packages)

FAILED=0
fail() { # message
  echo "FAIL: $1" >&2
  FAILED=1
}

for dir in "${SCANNED[@]}"; do
  if [ ! -d "$dir" ]; then
    fail "$dir: scanned directory is missing; update SCANNED in this guard"
    continue
  fi
  # Production sources only; specs assert values deliberately.
  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    file="${hit%%:*}"
    rest="${hit#*:}"
    line="${rest%%:*}"
    case " ${REGISTRIES[*]} ${ALLOWED_NON_REGISTRY[*]} " in
      *" $file "*)
        continue
        ;;
    esac
    fail "$hit: advisory-lock ids belong in a registry, not inline (#1500)"
  done <<<"$(find "$dir" -name node_modules -prune -o \
    -name dist -prune -o -name coverage -prune -o -name .turbo -prune -o \
    -name '*.spec.ts' -prune -o -type f -name '*.ts' -print0 \
    | xargs -0 grep -nE "$LOCK_LITERAL" 2>/dev/null || true)"
done

if [ "$FAILED" -ne 0 ]; then
  echo >&2
  echo 'Declare the id in packages/bot-common/src/locks/advisory-lock-ids.ts (or' >&2
  echo "Messenger's own registry) under a name that says what it locks, then read" >&2
  echo 'it from there. Never reuse, renumber, or change an existing value.' >&2
  exit 1
fi
echo 'ok: no advisory-lock id declared outside a registry'
