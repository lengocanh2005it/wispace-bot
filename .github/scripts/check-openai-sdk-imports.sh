#!/usr/bin/env bash
# Architectural check (#427): the OpenAI SDK is only allowed behind the
# provider adapter boundary (packages/llm-agent/src/provider/). The LLM usage
# domain consumes the provider-neutral LlmUsage contract — no app or shared
# package may import 'openai' directly.
#
# Usage: bash .github/scripts/check-openai-sdk-imports.sh [root]
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$ROOT"

FAILED=0
fail() { echo "FAIL: $1" >&2; FAILED=1; }

matches=$(grep -rEl "from ['\"]openai|import\(['\"]openai|require\(['\"]openai" packages/*/src apps/*/src --include='*.ts' 2>/dev/null | grep -v '^packages/llm-agent/src/provider/' || true)
if [ -n "$matches" ]; then
  while IFS= read -r f; do
    fail "$f: import of the OpenAI SDK outside packages/llm-agent/src/provider — use the LlmProviderAdapter + LlmUsage contract (#427)"
  done <<< "$matches"
fi

if [ "$FAILED" -ne 0 ]; then
  echo >&2
  echo 'The OpenAI SDK lives only behind the provider adapter boundary;' >&2
  echo 'consumers use the provider-neutral types from @wispace/llm-agent.' >&2
  exit 1
fi
echo 'ok: OpenAI SDK imports are confined to packages/llm-agent/src/provider'
