#!/usr/bin/env bash
# Tests for check-database-type-imports.sh (#423): detection of type-only
# @wispace/database imports, exemptions (packages/database, node_modules, dist)
# and the real-repo pass invariant.
# Run: bash .github/scripts/tests/check-database-type-imports.test.sh
set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/check-database-type-imports.sh"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

FAILED=0
fail() { echo "FAIL: $1" >&2; FAILED=1; }
pass() { echo "  ok: $1"; }

mkdir -p "$TEST_ROOT/apps/demo" "$TEST_ROOT/packages/demo" "$TEST_ROOT/packages/database"

write() { # rel-path (content via stdin)
  local rel="$1"
  mkdir -p "$(dirname "$TEST_ROOT/$rel")"
  cat > "$TEST_ROOT/$rel"
}

run_check() {
  bash "$SCRIPT" "$TEST_ROOT" >/dev/null 2>&1
}

# 1) Real repo must pass (post-refactor invariant).
if bash "$SCRIPT" >/dev/null 2>&1; then
  pass "real repo has no type-only @wispace/database imports"
else
  fail "real repo check failed — fix offending imports"
fi

# 2) import type from @wispace/database fails.
write "apps/demo/type-only.ts" <<'EOF'
import type { Platform } from '@wispace/database';
export const p: Platform = 'messenger';
EOF
if run_check; then fail "import type not detected"; else pass "import type detected"; fi
rm "$TEST_ROOT/apps/demo/type-only.ts"

# 3) multi-line import type fails.
write "apps/demo/type-only-multiline.ts" <<'EOF'
import type {
  OutboundDeliveryOutcome,
  Platform,
} from '@wispace/database';
export const p: Platform = 'messenger';
EOF
if run_check; then fail "multi-line import type not detected"; else pass "multi-line import type detected"; fi
rm "$TEST_ROOT/apps/demo/type-only-multiline.ts"

# 4) export type re-export fails.
write "apps/demo/type-reexport.ts" <<'EOF'
export type { ReportSendJobStatus } from '@wispace/database';
EOF
if run_check; then fail "export type re-export not detected"; else pass "export type re-export detected"; fi
rm "$TEST_ROOT/apps/demo/type-reexport.ts"

# 5) inline import() type reference fails.
write "apps/demo/inline-type.ts" <<'EOF'
export interface Row {
  state: import('@wispace/database').PlatformLinkState;
}
EOF
if run_check; then fail "inline import() type not detected"; else pass "inline import() type detected"; fi
rm "$TEST_ROOT/apps/demo/inline-type.ts"

# 6) Value imports from @wispace/database + type imports from owners pass.
write "apps/demo/value-import.ts" <<'EOF'
import { PlatformDeadLetterService } from '@wispace/database';
import type { Platform } from '@wispace/contracts';
import type { OutboundDeliveryOutcome } from '@wispace/contracts';
export const svc = PlatformDeadLetterService;
export const p: Platform = 'messenger';
export const o: OutboundDeliveryOutcome = 'sent';
EOF
write "packages/demo/contracts-import.ts" <<'EOF'
import type { Platform } from '@wispace/contracts';
export const p: Platform = 'discord';
EOF
if run_check; then pass "value import + canonical-owner imports pass"; else fail "false positive on value import"; fi

# 7) packages/database is exempt.
write "packages/database/own-type-import.ts" <<'EOF'
import type { Platform } from '@wispace/contracts';
export const p: Platform = 'zalo';
EOF
if run_check; then pass "packages/database exempt"; else fail "packages/database not exempt"; fi

# 8) node_modules and dist are excluded.
write "apps/demo/node_modules/x/bad.ts" <<'EOF'
import type { Platform } from '@wispace/database';
EOF
write "apps/demo/dist/bad.ts" <<'EOF'
import type { Platform } from '@wispace/database';
EOF
if run_check; then pass "node_modules/dist excluded"; else fail "node_modules/dist not excluded"; fi

exit "$FAILED"
