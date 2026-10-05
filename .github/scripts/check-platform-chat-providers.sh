#!/usr/bin/env bash
# Architectural check (#1127): the shared spine of the chat graph has one
# declaration — createPlatformChatProviders in @wispace/chat-agent. Each bot's
# chat module wires it with a single call; hand-assembling the same spine per
# bot is what produced three near-duplicate composition roots whose option drift
# nothing reported.
#
# Two rules:
#   1. every chat module calls createPlatformChatProviders;
#   2. no module under apps/*/src re-declares a provider whose `provide:` key is
#      a token the factory already provides.
#
# The token list is read out of the factory's own PLATFORM_CHAT_PROVIDER_TOKENS
# declaration at run time, so the check and the factory cannot drift apart. This
# job runs with no install and no build, hence source parsing rather than a
# package import.
#
# Deliberately NOT covered: test doubles. The privacy contract specs override
# these tokens through Test.createTestingModule, which is a test fixture and not
# a second composition root, so the scan is limited to `*.module.ts`.
#
# Usage: bash .github/scripts/check-platform-chat-providers.sh [root]
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$ROOT"

FACTORY=packages/chat-agent/src/platform-chat-providers.factory.ts

CHAT_MODULES=(
  apps/zalo-bot/src/modules/zalo-chat/zalo-chat.module.ts
  apps/discord-bot/src/modules/discord-chat/discord-chat.module.ts
  apps/messenger-bot/src/modules/messenger/chat-pipeline.module.ts
)

FAILED=0
fail() { # message
  echo "FAIL: $1" >&2
  FAILED=1
}

if [ ! -f "$FACTORY" ]; then
  fail "$FACTORY: factory source is missing; this guard cannot read the token list"
  echo >&2
  echo 'The platform chat provider factory has no source to read its token list from.' >&2
  exit 1
fi

# Read the token list from the factory rather than repeating it here. `<<` is a
# herestring, not a pipe: FAILED must be mutated in this shell.
TOKENS=''
while IFS= read -r token; do
  [ -n "$token" ] || continue
  TOKENS="${TOKENS}${token}"$'\n'
done <<<"$(awk '
  /PLATFORM_CHAT_PROVIDER_TOKENS = \[/ { grab = 1; next }
  grab && /\] as const;/ { grab = 0 }
  grab {
    gsub(/,/, "", $0)
    gsub(/^[ \t]+|[ \t]+$/, "", $0)
    if ($0 != "") print
  }
' "$FACTORY")"

if [ -z "$TOKENS" ]; then
  fail "$FACTORY: no tokens read from PLATFORM_CHAT_PROVIDER_TOKENS; this guard would pass on an empty list"
fi

# Rule 1 — every chat module wires the spine through the factory.
for f in "${CHAT_MODULES[@]}"; do
  if [ ! -f "$f" ]; then
    fail "$f: chat module is missing; update CHAT_MODULES in this guard"
    continue
  fi
  if ! grep -qE 'createPlatformChatProviders[[:space:]]*\(' "$f"; then
    fail "$f: chat module does not call createPlatformChatProviders (#1127) — wire the shared spine with one factory call instead of per-bot providers"
  fi
done

# Rule 2 — the factory's tokens are not re-declared anywhere in apps/*/src.
while IFS= read -r token; do
  [ -n "$token" ] || continue
  # <<< herestring, not a pipe: fail() must mutate FAILED in this shell
  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    fail "$hit: provides $token, which createPlatformChatProviders already provides (#1127) — delete the override; the factory owns this binding"
  done <<<"$(grep -rnE "provide:[[:space:]]*$token\b" apps/*/src --include='*.module.ts' 2>/dev/null || true)"
done <<<"$TOKENS"

if [ "$FAILED" -ne 0 ]; then
  echo >&2
  echo 'The shared chat spine has one declaration: createPlatformChatProviders.' >&2
  echo 'Each bot states every divergent value at the call site and nothing else.' >&2
  exit 1
fi
echo 'ok: chat modules wire the shared spine through createPlatformChatProviders'