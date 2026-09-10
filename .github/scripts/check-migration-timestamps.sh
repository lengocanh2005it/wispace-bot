#!/usr/bin/env bash
# Fail if runtime migration filenames, class names, or effective names collide.
set -euo pipefail

MIGRATIONS_DIR="${1:-packages/database/src/migrations}"

if [[ ! -d "$MIGRATIONS_DIR" ]]; then
  echo "ERROR: Migration directory does not exist: $MIGRATIONS_DIR" >&2
  exit 1
fi

RECORDS_DIR=$(mktemp -d)
trap 'rm -rf "$RECORDS_DIR"' EXIT

filename_records="$RECORDS_DIR/filenames"
class_records="$RECORDS_DIR/classes"
name_records="$RECORDS_DIR/names"
failed=0

while IFS= read -r -d '' file; do
  filename="${file##*/}"
  if [[ "$filename" =~ ^([0-9]{13})- ]]; then
    printf '%s\t%s\n' "${BASH_REMATCH[1]}" "$filename" >>"$filename_records"
  else
    echo "ERROR: Migration filename has no 13-digit timestamp: $filename" >&2
    failed=1
  fi

  class_name=$(sed -nE \
    's/^[[:space:]]*export class ([A-Za-z_][A-Za-z0-9_]*).*implements[[:space:]]+MigrationInterface.*/\1/p' \
    "$file" | head -n 1)
  if [[ -z "$class_name" ]]; then
    echo "ERROR: Could not find a MigrationInterface class in $filename" >&2
    failed=1
    continue
  fi

  class_timestamp="${class_name: -13}"
  if [[ ! "$class_timestamp" =~ ^[0-9]{13}$ ]]; then
    echo "ERROR: Migration class has no 13-digit timestamp: $class_name" >&2
    failed=1
  else
    printf '%s\t%s\t%s\n' "$class_timestamp" "$filename" "$class_name" >>"$class_records"
  fi

  migration_name=$(sed -nE \
    "s/^[[:space:]]*name[[:space:]]*=[[:space:]]*['\"]([^'\"]+)['\"][[:space:]]*;.*/\1/p" \
    "$file" | head -n 1)
  migration_name="${migration_name:-$class_name}"
  name_timestamp="${migration_name: -13}"
  if [[ ! "$name_timestamp" =~ ^[0-9]{13}$ ]]; then
    echo "ERROR: Effective migration name has no 13-digit timestamp: $migration_name" >&2
    failed=1
  else
    printf '%s\t%s\t%s\n' "$name_timestamp" "$filename" "$migration_name" >>"$name_records"
  fi
done < <(
  find "$MIGRATIONS_DIR" -maxdepth 1 -type f -name '*.ts' ! -name '*.spec.ts' -print0 \
    | sort -z
)

check_duplicates() {
  local label="$1"
  local records="$2"
  local duplicates

  [[ -s "$records" ]] || return 0
  duplicates=$(cut -f1 "$records" | sort -n | uniq -d)
  [[ -n "$duplicates" ]] || return 0

  failed=1
  echo "ERROR: Duplicate migration timestamps found in $label:"
  while IFS= read -r timestamp; do
    [[ -n "$timestamp" ]] || continue
    echo "  $timestamp:"
    awk -F '\t' -v timestamp="$timestamp" '$1 == timestamp {
      printf "    %s (%s)\n", $2, $3
    }' "$records"
  done <<<"$duplicates"
}

check_duplicates filenames "$filename_records"
check_duplicates classes "$class_records"
check_duplicates "effective migration names" "$name_records"

if ((failed)); then
  exit 1
fi

echo "OK: No duplicate migration timestamps."
