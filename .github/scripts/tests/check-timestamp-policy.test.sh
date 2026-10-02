#!/usr/bin/env bash
# Regression tests for the timestamp column-type guard (#1227, ADR-0051).
#
# The guard is diff-based: a whole-repo scan would fail on the 96 bare
# `timestamptz` literals already in the tree, and a whole-file scan would force
# a caller who touches one legacy entity to migrate every literal in it. Each
# case below therefore builds a throwaway git repo with a base commit, so the
# diff the guard reads is exactly the change under test.
set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/check-timestamp-policy.sh"
REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
WORK_ROOT="$(mktemp -d)"
trap 'rm -rf "$WORK_ROOT"' EXIT

FAILED=0

fail() { echo "FAIL: $1" >&2; FAILED=1; }
pass() { echo "  ok: $1"; }

ENTITY='packages/database/src/entities/probe.entity.ts'
LEGACY_ENTITY='packages/database/src/entities/legacy.entity.ts'

# new_repo <name> — repo path with a base commit holding one legacy literal.
# The base sha is recorded per repo name so run_check can diff against it.
new_repo() {
  local repo="$WORK_ROOT/$1"
  mkdir -p "$repo/packages/database/src/entities"
  printf '%s\n' \
    "import { Column } from 'typeorm';" \
    "export class Legacy {" \
    "  @Column({ name: 'expires_at', type: 'timestamptz' })" \
    "  expiresAt!: Date;" \
    "}" >"$repo/$LEGACY_ENTITY"
  git -C "$repo" init -q
  git -C "$repo" config user.email test@example.com
  git -C "$repo" config user.name test
  git -C "$repo" config core.autocrlf false
  git -C "$repo" add -A
  git -C "$repo" commit -qm base
  printf '%s' "$(git -C "$repo" rev-parse HEAD)" >"$repo.base-sha"
  echo "$repo"
}

base_of() { cat "$1.base-sha"; }

append_entity() { # repo line...
  local repo="$1"
  shift
  : >"$repo/$ENTITY"
  printf '%s\n' "$@" >>"$repo/$ENTITY"
  git -C "$repo" add -A
}

run_check() { # name repo expected
  local name="$1" repo="$2" expected="$3"
  local output status

  # Invoked through bash, not executed directly: repository check scripts are
  # committed without an executable bit and CI calls them the same way.
  if output=$(bash "$SCRIPT" "$(base_of "$repo")" "$repo" 2>&1); then status=0; else status=$?; fi

  if [[ "$expected" == pass && $status -eq 0 ]]; then
    pass "$name"
  elif [[ "$expected" == fail && $status -ne 0 && "$output" == *'new bare timestamp column type'* ]]; then
    pass "$name"
  else
    echo "$output" >&2
    fail "$name (status=$status, expected=$expected)"
  fi
}

# 1. Untouched repository passes — the existing literals are grandfathered.
repo=$(new_repo untouched)
run_check "legacy literals with no change pass" "$repo" pass

# 2. A newly added bare timestamptz column fails.
repo=$(new_repo new-timestamptz)
append_entity "$repo" \
  "import { Column } from 'typeorm';" \
  "export class Probe {" \
  "  @Column({ name: 'claimed_at', type: 'timestamptz' })" \
  "  claimedAt!: Date;" \
  "}"
run_check "new bare timestamptz column fails" "$repo" fail

# 3. A newly added bare date column fails too — the daily-bucket category.
repo=$(new_repo new-date)
append_entity "$repo" \
  "import { Column } from 'typeorm';" \
  "export class Probe {" \
  "  @Column({ name: 'usage_date', type: 'date' })" \
  "  usageDate!: string;" \
  "}"
run_check "new bare date column fails" "$repo" fail

# 4. Using the shared constant passes.
repo=$(new_repo shared-constant)
append_entity "$repo" \
  "import { Column } from 'typeorm';" \
  "import { TIMESTAMPTZ } from '@wispace/contracts';" \
  "export class Probe {" \
  "  @Column({ name: 'claimed_at', type: TIMESTAMPTZ })" \
  "  claimedAt!: Date;" \
  "}"
run_check "new column using TIMESTAMPTZ passes" "$repo" pass

# 5. The naive timestamp type is not guarded by this policy.
repo=$(new_repo naive-timestamp)
append_entity "$repo" \
  "import { Column } from 'typeorm';" \
  "export class Probe {" \
  "  @Column({ name: 'legacy_local', type: 'timestamp' })" \
  "  legacyLocal!: Date;" \
  "}"
run_check "new naive timestamp column passes" "$repo" pass

# 6. TypeORM's own decorators and a database-clock default are not guarded.
repo=$(new_repo framework-defaults)
append_entity "$repo" \
  "import { Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';" \
  "export class Probe {" \
  "  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })" \
  "  createdAt!: Date;" \
  "  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })" \
  "  updatedAt!: Date;" \
  "  @Column({ name: 'sent_at', type: 'timestamptz', default: () => 'now()' })" \
  "  sentAt!: Date;" \
  "}"
run_check "TypeORM date decorators and a now() default pass" "$repo" pass

# 7. Touching a legacy entity to add one column does not fail on the literals
#    that were already there. This is the case a whole-file scan gets wrong.
repo=$(new_repo touch-legacy)
printf '%s\n' \
  "export class Extra {" \
  "  @Column({ name: 'extra_at', type: TIMESTAMPTZ })" \
  "  extraAt!: Date;" \
  "}" >>"$repo/$LEGACY_ENTITY"
git -C "$repo" add -A
run_check "legacy literals in a touched file are grandfathered" "$repo" pass

# 8. A deletion-only change passes.
repo=$(new_repo deletion)
git -C "$repo" rm -q "$LEGACY_ENTITY"
run_check "deletion-only change passes" "$repo" pass

# 9. A non-entity file is never inspected.
repo=$(new_repo non-entity)
mkdir -p "$repo/packages/database/src/services"
printf '%s\n' 'export const QUERY = "SELECT now()";' \
  >"$repo/packages/database/src/services/probe.service.ts"
git -C "$repo" add -A
run_check "non-entity file containing now() passes" "$repo" pass

# 10. The real repository passes: the guard must be green on its own tree.
if output=$(bash "$SCRIPT" HEAD "$REPO_ROOT" 2>&1); then
  pass "current repository inventory passes"
else
  echo "$output" >&2
  fail "current repository inventory passes"
fi

exit "$FAILED"
