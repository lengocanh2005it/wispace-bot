#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ "$#" -gt 0 ]; then
  ROOT="$1"
else
  ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
fi
exec node "$SCRIPT_DIR/check-eval-rehash-pr.js" "$ROOT"
