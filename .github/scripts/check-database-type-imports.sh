#!/usr/bin/env bash
# Architectural check (#423): no TypeScript file outside packages/database may
# import @wispace/database exclusively for types. Cross-context contracts have
# canonical owners (@wispace/contracts + the context package that owns them);
# files that need runtime values from @wispace/database must use value imports.
# Catches `import type`, `export type` re-exports and inline
# import('@wispace/database') type references.
# ponytail: line-collapse + [^;]* parsing, semicolon-omitting files would slip
# through — repo enforces semicolons via oxfmt.
#
# Usage: bash .github/scripts/check-database-type-imports.sh [root]
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$ROOT"

FAILED=0
fail() { echo "FAIL: $1" >&2; FAILED=1; }

scan_file() { # file
  local f="$1"
  local content
  content=$(tr '\n' ' ' < "$f")
  if printf '%s' "$content" | grep -qE "import type[^;]*from ['\"]@wispace/database['\"]"; then
    fail "$f: type-only import from @wispace/database"
  fi
  if printf '%s' "$content" | grep -qE "export type[^;]*from ['\"]@wispace/database['\"]"; then
    fail "$f: type-only re-export from @wispace/database"
  fi
  if printf '%s' "$content" | grep -qE "import\(['\"]@wispace/database['\"]\)"; then
    fail "$f: inline import('@wispace/database') type reference"
  fi
}

while IFS= read -r f; do
  scan_file "$f"
done < <(
  find apps packages -type f -name '*.ts' \
    ! -path 'packages/database/*' \
    ! -path '*/node_modules/*' \
    ! -path '*/dist/*' \
    2>/dev/null
)

if [ "$FAILED" -ne 0 ]; then
  echo >&2
  echo 'Cross-context contracts are owned by @wispace/contracts and their context packages.' >&2
  echo 'Import types from the canonical owner, never type-only from @wispace/database.' >&2
  exit 1
fi
echo 'ok: no type-only imports of @wispace/database outside packages/database'
