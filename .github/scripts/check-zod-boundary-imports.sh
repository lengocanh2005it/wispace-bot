#!/usr/bin/env bash
# Architectural check (#1053, ADR 0010): zod is banned in the two packages
# that must stay schema-free — packages/contracts (zero-dependency shared
# kernel) and packages/chat-metering (allowed deps: typeorm +
# @wispace/llm-agent). Types stay plain there; zod schemas live in the
# consuming packages and z.infer yields structurally-compatible types.
#
# Usage: bash .github/scripts/check-zod-boundary-imports.sh [root]
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$ROOT"

PACKAGES=(packages/contracts packages/chat-metering)
FAILED=0
fail() { echo "FAIL: $1" >&2; FAILED=1; }

for pkg in "${PACKAGES[@]}"; do
  if [ -f "$pkg/package.json" ] && grep -Eq '"zod(/[^"]*)?"[[:space:]]*:' "$pkg/package.json"; then
    fail "$pkg/package.json: zod declared as a dependency — banned by ADR 0010"
  fi
  if [ -d "$pkg/src" ]; then
    matches=$(grep -rEl "from ['\"]zod|import\(['\"]zod|require\(['\"]zod" "$pkg/src" --include='*.ts' 2>/dev/null || true)
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      fail "$f: import of zod in $pkg — banned by ADR 0010 (contracts is zero-dependency; chat-metering allows only typeorm + @wispace/llm-agent)"
    done <<< "$matches"
  fi
done

if [ "$FAILED" -ne 0 ]; then
  echo >&2
  echo 'zod stays out of packages/contracts and packages/chat-metering;' >&2
  echo 'keep contracts types plain and metering deps at typeorm + @wispace/llm-agent.' >&2
  echo 'See docs/adr/0010-adopt-zod-at-trust-boundaries.md.' >&2
  exit 1
fi
echo 'ok: zod is absent from packages/contracts and packages/chat-metering'
