#!/usr/bin/env bash
# Regression tests for the runtime migration timestamp guard (#340).
set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/check-migration-timestamps.sh"
ROOT="$(cd "$(dirname "$SCRIPT")/../.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

FAILED=0

fail() { echo "FAIL: $1" >&2; FAILED=1; }
pass() { echo "  ok: $1"; }

write_migration() {
  local dir="$1"
  local filename="$2"
  local class_name="$3"
  local migration_name="$4"

  printf '%s\n' \
    "import type { MigrationInterface, QueryRunner } from 'typeorm';" \
    "export class $class_name implements MigrationInterface {" \
    "  name = '$migration_name';" \
    '  async up(_queryRunner: QueryRunner): Promise<void> {}' \
    '  async down(_queryRunner: QueryRunner): Promise<void> {}' \
    '}' >"$dir/$filename"
}

run_check() {
  local name="$1"
  local dir="$2"
  local expected="$3"
  local output
  local status

  if output=$(bash "$SCRIPT" "$dir" 2>&1); then
    status=0
  else
    status=$?
  fi

  if [[ "$expected" == pass && "$status" -eq 0 ]]; then
    pass "$name"
  elif [[ "$expected" == fail && "$status" -ne 0 && "$output" == *'Duplicate migration timestamps found'* ]]; then
    pass "$name"
  else
    echo "$output" >&2
    fail "$name (status=$status)"
  fi
}

run_check "current migration inventory passes" "$ROOT/packages/database/src/migrations" pass

unique_dir="$TEST_ROOT/unique"
mkdir -p "$unique_dir"
write_migration "$unique_dir" '1111111111111-First.ts' 'First1111111111111' 'First1111111111111'
write_migration "$unique_dir" '2222222222222-Second.ts' 'Second2222222222222' 'Second2222222222222'
run_check "unique filenames and runtime names pass" "$unique_dir" pass

duplicate_class_dir="$TEST_ROOT/duplicate-class"
mkdir -p "$duplicate_class_dir"
write_migration "$duplicate_class_dir" '1111111111111-First.ts' 'First1111111111111' 'First1111111111111'
write_migration "$duplicate_class_dir" '2222222222222-Second.ts' 'Second1111111111111' 'Second2222222222222'
run_check "duplicate class timestamps fail" "$duplicate_class_dir" fail

duplicate_name_dir="$TEST_ROOT/duplicate-name"
mkdir -p "$duplicate_name_dir"
write_migration "$duplicate_name_dir" '1111111111111-First.ts' 'First1111111111111' 'Shared1111111111111'
write_migration "$duplicate_name_dir" '2222222222222-Second.ts' 'Second2222222222222' 'Shared1111111111111'
run_check "duplicate effective names fail" "$duplicate_name_dir" fail

duplicate_file_dir="$TEST_ROOT/duplicate-file"
mkdir -p "$duplicate_file_dir"
write_migration "$duplicate_file_dir" '1111111111111-First.ts' 'First1111111111111' 'First1111111111111'
write_migration "$duplicate_file_dir" '1111111111111-Second.ts' 'Second2222222222222' 'Second2222222222222'
run_check "duplicate filename timestamps fail" "$duplicate_file_dir" fail

exit "$FAILED"
