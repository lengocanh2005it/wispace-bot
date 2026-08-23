#!/usr/bin/env bash
# Fail if any two runtime migration files share the same timestamp prefix.
set -euo pipefail

MIGRATIONS_DIR="${1:-packages/database/src/migrations}"

dupes=$(find "$MIGRATIONS_DIR" -maxdepth 1 -name '*.ts' ! -name '*.spec.ts' -printf '%f\n' \
  | sed 's/-.*$//' \
  | sort \
  | uniq -d)

if [ -n "$dupes" ]; then
  echo "ERROR: Duplicate migration timestamps found:"
  echo "$dupes" | while read -r ts; do
    echo "  $ts:"
    find "$MIGRATIONS_DIR" -maxdepth 1 -name "${ts}-*.ts" ! -name '*.spec.ts' -printf '    %f\n'
  done
  exit 1
fi

echo "OK: No duplicate migration timestamps."
