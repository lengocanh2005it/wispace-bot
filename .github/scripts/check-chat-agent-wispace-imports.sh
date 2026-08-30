#!/usr/bin/env bash
# Architectural check (#425): packages/chat-agent must not depend on concrete
# WISPACE client classes — WISPACE data access goes through the capability
# ports (wispace-capability.ports.ts) with adapters wired by each bot's
# composition root. Catches source imports and the package.json dependency.
#
# Usage: bash .github/scripts/check-chat-agent-wispace-imports.sh [root]
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$ROOT"

FAILED=0
fail() { echo "FAIL: $1" >&2; FAILED=1; }

matches=$(grep -rEl "from ['\"]@wispace/wispace-client['\"]|import\(['\"]@wispace/wispace-client['\"]\)" packages/chat-agent/src --include='*.ts' 2>/dev/null || true)
if [ -n "$matches" ]; then
  # <<< herestring, not a pipe: fail() must mutate FAILED in this shell
  while IFS= read -r f; do
    fail "$f: import of @wispace/wispace-client in packages/chat-agent"
  done <<< "$matches"
fi

if grep -q '"@wispace/wispace-client"' packages/chat-agent/package.json; then
  fail "packages/chat-agent/package.json: dependency on @wispace/wispace-client"
fi

if [ "$FAILED" -ne 0 ]; then
  echo >&2
  echo 'WISPACE data access in chat-agent goes through the capability ports' >&2
  echo '(wispace-capability.ports.ts); concrete adapters live in each bot app.' >&2
  exit 1
fi
echo 'ok: chat-agent has no wispace-client dependency'
