#!/usr/bin/env bash
# Architectural check (#426): the webhook inbound workflow (ingest, retry
# cron, retention cleanup, ingress port) lives in @wispace/webhook-inbound —
# apps must not import it from @wispace/database, and the database package
# must not re-export it. The database package keeps only entities, types,
# migrations, and connection options.
#
# Usage: bash .github/scripts/check-webhook-inbound-database-imports.sh [root]
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$ROOT"

FAILED=0
fail() { echo "FAIL: $1" >&2; FAILED=1; }

# Symbols that moved to @wispace/webhook-inbound. Deliberately narrow so the
# WebhookInboundEventEntity / WebhookInboundEventStatus that STAY in
# @wispace/database are not matched.
MOVED='PlatformWebhookInbound\w*|WebhookInboundIngressPort|WEBHOOK_INBOUND_INGRESS_PORT|WebhookIngestResult|readInboundRetryConfig|IngestInboundEvent\w*|InboundEventRow|InboundRetryConfig|WebhookInboundRetryCronOptions|WebhookInboundCleanupOptions'

# 1. Apps must not reach the moved workflow through @wispace/database —
#    checked per import/export statement (multi-line safe), so files that
#    legitimately import WebhookInboundEventEntity from @wispace/database
#    while pulling the workflow from @wispace/webhook-inbound stay green.
matches=$(grep -rlE "$MOVED" apps/*/src --include='*.ts' 2>/dev/null || true)
if [ -n "$matches" ]; then
  while IFS= read -r f; do
    # Match (exit 0) only when an import or re-export statement pulls a
    # moved symbol from @wispace/database.
    if perl -0777 -ne "exit(/(import|export)\\s+[^;{]*\\{[^}]*\\b($MOVED)\\b[^}]*\\}\\s*from\\s*['\\\"]\\@wispace\\/database['\\\"]/s ? 0 : 1)" "$f"; then
      fail "$f: webhook inbound workflow imported from @wispace/database — use @wispace/webhook-inbound"
    fi
  done <<< "$matches"
fi

# 2. The database package must not re-export the moved workflow.
if grep -qE "$MOVED" packages/database/src/index.ts; then
  fail "packages/database/src/index.ts re-exports the webhook inbound workflow (owned by @wispace/webhook-inbound)"
fi

if [ "$FAILED" -ne 0 ]; then
  echo >&2
  echo 'The webhook inbound workflow lives in packages/webhook-inbound; @wispace/database' >&2
  echo 'keeps only entities, migrations, types, and connection options (#426).' >&2
  exit 1
fi
echo 'ok: webhook inbound workflow is not imported via @wispace/database'
