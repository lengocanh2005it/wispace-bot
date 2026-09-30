#!/usr/bin/env bash
# Architectural check (#1493, ADR-0011): a staged reschedule may be committed
# only by a platform button/postback carrying its one-time approval token. The
# production reschedule store requires that token, so a token-less entry path
# is not a degraded path — it is a dead one that can only answer the learner
# with an authentication failure. Two such paths shipped as live code and read
# as real, which is what made the #1483 audit conclude a double-tap race.
#
# Three rules keep them out:
#   1. No @Button binding on either reschedule action. Discord routes both
#      actions through the single interactionCreate listener.
#   2. No bare-payload comparison against the Messenger postback constants. The
#      router matches the token-bound payload only.
#   3. The token stays required by type at every boundary that emits or accepts
#      it, so it cannot be re-optionalised and a bare branch with it.
#
# A token-less TEXT cancel stays legal: cancelling a staged proposal is not a
# calendar write, so it needs no token. RescheduleConfirmationService.cancel()
# keeps its token optional and is deliberately not covered here.
#
# Usage: bash .github/scripts/check-reschedule-confirm-handlers.sh [root]
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$ROOT"

# A fixed-id button binding or a bare postback comparison — the two shapes of a
# token-less entry path.
TOKEN_LESS_ENTRY='@Button\(\s*(RESCHEDULE_CONFIRM_CUSTOM_ID|RESCHEDULE_CANCEL_CUSTOM_ID)|payload ===\s*(CONFIRM_RESCHEDULE_POSTBACK|CANCEL_RESCHEDULE_POSTBACK)'

# The token is required everywhere except StageResult.confirmationToken, which
# reschedule-confirm owns and is intentionally non-enumerable. So no other
# workspace may declare it optional.
OPTIONAL_TOKEN='confirmationToken\?: string'

SCANNED=(apps packages/chat-agent/src)

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
  # <<< herestring, not a pipe: fail() must mutate FAILED in this shell
  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    fail "$hit: token-less reschedule entry path is forbidden (ADR-0011, #1493)"
  done <<<"$(grep -rnE "$TOKEN_LESS_ENTRY" --include='*.ts' "$dir" || true)"
  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    fail "$hit: the approval token must stay required by type (#1493)"
  done <<<"$(grep -rnE "$OPTIONAL_TOKEN" --include='*.ts' "$dir" || true)"
done

if [ "$FAILED" -ne 0 ]; then
  echo >&2
  echo 'Every reschedule confirm/cancel button must carry its proposal approval' >&2
  echo 'token (ADR-0011). Route the token-bound payload through the one handler;' >&2
  echo 'a token-less path can only answer the learner with an auth failure.' >&2
  exit 1
fi
echo 'ok: no token-less reschedule confirm/cancel entry path'
