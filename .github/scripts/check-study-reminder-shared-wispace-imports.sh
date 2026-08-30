#!/usr/bin/env bash
# Architectural check (#424): packages/study-reminder-shared must not reference
# the concrete WISPACE client classes — the shared reminder seam consumes the
# structural ports (GET_SESSIONS token, StudyCalendarPort, RescheduleConfigPort)
# with concrete adapters wired by each bot's composition root. Pure helpers and
# type-only contracts from @wispace/wispace-client remain allowed.
#
# Usage: bash .github/scripts/check-study-reminder-shared-wispace-imports.sh [root]
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$ROOT"

FAILED=0
fail() { echo "FAIL: $1" >&2; FAILED=1; }

matches=$(grep -rEn '\b(WispaceCalendarService|WispaceConfigService)\b' packages/study-reminder-shared/src --include='*.ts' 2>/dev/null || true)
if [ -n "$matches" ]; then
  # <<< herestring, not a pipe: fail() must mutate FAILED in this shell
  while IFS= read -r line; do
    fail "packages/study-reminder-shared/src: reference to concrete WISPACE client class — $line"
  done <<< "$matches"
fi

if [ "$FAILED" -ne 0 ]; then
  echo >&2
  echo 'The study-reminder seam consumes structural ports (GET_SESSIONS token,' >&2
  echo 'StudyCalendarPort, RescheduleConfigPort); concrete adapters live in each bot app.' >&2
  exit 1
fi
echo 'ok: study-reminder-shared has no concrete WISPACE client class references'
