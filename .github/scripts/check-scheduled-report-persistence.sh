#!/usr/bin/env bash
# Architectural check (#744): Messenger and Discord use the shared scheduled
# report persistence adapters. Deleted local send-job classes and Messenger's
# old claim methods must not quietly return in a later refactor.
#
# Usage: bash .github/scripts/check-scheduled-report-persistence.sh [root]
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$ROOT"

FAILED=0
fail() { echo "FAIL: $1" >&2; FAILED=1; }

for path in \
  apps/messenger-bot/src/modules/scheduler/infrastructure/persistence/report-send-job.repository.ts \
  apps/discord-bot/src/modules/discord-chat/infrastructure/persistence/discord-report-send-job.repository.ts
do
  if [ -e "$path" ]; then
    fail "$path: deleted local send-job repository still exists — use @wispace/database"
  fi
done

old_class_refs=$(grep -RInE \
  '(^|[^[:alnum:]_])(ReportSendJobRepository|DiscordReportSendJobRepository)([^[:alnum:]_]|$)' \
  apps/*/src packages/*/src --include='*.ts' 2>/dev/null || true)
if [ -n "$old_class_refs" ]; then
  while IFS= read -r line; do
    fail "legacy send-job repository reference: $line"
  done <<< "$old_class_refs"
fi

old_claim_methods=$(grep -nE \
  '(hasSentScheduledReportToday|hasAnyPlatformSentReportToday|listUserIdsWithSentReportToday|tryClaimScheduledReport|markScheduledReportClaimSent|releaseScheduledReportClaim|releaseExpiredScheduledReportClaims)' \
  apps/messenger-bot/src/modules/messenger/infrastructure/persistence/messenger.repository.ts 2>/dev/null || true)
if [ -n "$old_claim_methods" ]; then
  while IFS= read -r line; do
    fail "MessengerRepository still owns a scheduled-report claim method: $line"
  done <<< "$old_claim_methods"
fi

old_path_refs=$(grep -RInE \
  'infrastructure/persistence/(report-send-job\.repository|discord-report-send-job\.repository)' \
  apps/*/src packages/*/src --include='*.ts' 2>/dev/null || true)
if [ -n "$old_path_refs" ]; then
  while IFS= read -r line; do
    fail "legacy local send-job repository path reference: $line"
  done <<< "$old_path_refs"
fi

if [ "$FAILED" -ne 0 ]; then
  echo >&2
  echo 'Scheduled-report claim transitions belong to the shared platform adapter,' >&2
  echo 'and Messenger/Discord send jobs belong to PlatformReportSendJobRepository.' >&2
  exit 1
fi
echo 'ok: scheduled-report persistence has no deleted local adapter references'
