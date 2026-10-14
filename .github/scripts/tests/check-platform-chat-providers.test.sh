#!/usr/bin/env bash
# Tests for check-platform-chat-providers.sh (#1127): the two rules must go red
# on a fixture that violates each of them, the green tree must stay green, and a
# missing factory must fail closed rather than pass on an empty token list.
# Run: bash .github/scripts/tests/check-platform-chat-providers.test.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/check-platform-chat-providers.sh"
FACTORY_REL=packages/chat-agent/src/platform-chat-providers.factory.ts
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

FAILED=0
fail() { echo "FAIL: $1" >&2; FAILED=1; }
pass() { echo "  ok: $1"; }

write() { # rel-path (content via stdin)
  local rel="$1"
  mkdir -p "$(dirname "$TEST_ROOT/$rel")"
  cat > "$TEST_ROOT/$rel"
}

# A fixture is a valid tree unless a case says otherwise: the real factory
# source (so the token list is the real one) plus three chat modules that each
# call the factory and declare nothing of its tokens.
reset_fixture() {
  rm -rf "$TEST_ROOT"
  mkdir -p "$TEST_ROOT/$(dirname "$FACTORY_REL")"
  cp "$REPO_ROOT/$FACTORY_REL" "$TEST_ROOT/$FACTORY_REL"

  local m
  for m in \
    apps/zalo-bot/src/modules/zalo-chat/zalo-chat.module.ts \
    apps/discord-bot/src/modules/discord-chat/discord-chat.module.ts \
    apps/messenger-bot/src/modules/messenger/chat-pipeline.module.ts; do
    mkdir -p "$TEST_ROOT/$(dirname "$m")"
    cat > "$TEST_ROOT/$m" <<'EOF'
import { createPlatformChatProviders } from '@wispace/chat-agent';

export const ChatModule = {
  providers: [...createPlatformChatProviders({ platform: 'zalo' })],
};
EOF
  done
}

run_check() {
  bash "$SCRIPT" "$TEST_ROOT" >/dev/null 2>&1
}

# 1) Real repo must pass (post-migration invariant).
if bash "$SCRIPT" >/dev/null 2>&1; then
  pass "real tree wires all three chat modules through the factory"
else
  fail "real tree check failed — a chat module stopped calling the factory"
fi

# 2) A chat module that no longer calls the factory is rule 1.
reset_fixture
write apps/zalo-bot/src/modules/zalo-chat/zalo-chat.module.ts <<'EOF'
import { PlatformAgentService } from '@wispace/chat-agent';

export const ChatModule = { providers: [{ provide: PlatformAgentService }] };
EOF
if run_check; then
  fail "rule 1 did not fire — a chat module without the factory call passed"
else
  pass "rule 1 fires when a chat module stops calling createPlatformChatProviders"
fi

# 3) A module re-declaring a factory-provided token is rule 2. The token is
#    read out of the fixture's own factory copy, not hardcoded here.
for token in PlatformChatHistoryService PlatformAgentService RedisChatQueueWorkerService LEARNER_PROFILE_STORE; do
  reset_fixture
  write apps/messenger-bot/src/modules/messenger/chat-pipeline.module.ts <<EOF
import { $token } from '@wispace/chat-agent';

export const ChatModule = { providers: [{ provide: $token, useValue: {} }] };
EOF
  if run_check; then
    fail "rule 2 did not fire for $token"
  else
    pass "rule 2 fires when a module re-declares $token"
  fi
done

# 4) A re-declaration outside the three chat modules is still rule 2 — the scan
#    covers every module under apps/*/src, not a fixed file list.
reset_fixture
write apps/zalo-bot/src/modules/zalo-ops/zalo-ops.module.ts <<'EOF'
import { LEARNER_PROFILE_STORE } from '@wispace/learner-profile';

export const OpsModule = { providers: [{ provide: LEARNER_PROFILE_STORE, useValue: {} }] };
EOF
if run_check; then
  fail "rule 2 did not fire outside the chat modules"
else
  pass "rule 2 fires for a non-chat module that re-declares a factory token"
fi

# 5) Test doubles are exempt: the privacy contract specs override these tokens
#    through Test.createTestingModule, which is a fixture, not a second
#    composition root.
reset_fixture
write apps/discord-bot/src/modules/discord-ops/discord-privacy.contract.spec.ts <<'EOF'
import { PlatformAgentService } from '@wispace/chat-agent';

export const providers = [{ provide: PlatformAgentService, useValue: {} }];
EOF
if run_check; then
  pass "test doubles overriding a factory token are exempt"
else
  fail "false positive on a test double in a *.spec.ts"
fi

# 6) A missing factory fails closed rather than passing on an empty token list.
reset_fixture
rm "$TEST_ROOT/$FACTORY_REL"
if run_check; then
  fail "a missing factory source passed — an empty token list would pass rule 2 silently"
else
  pass "missing factory source fails closed"
fi

# 7) An empty token list also fails closed: the guard must not silently degrade
#    into a no-op if the declaration is renamed or emptied.
reset_fixture
write "$FACTORY_REL" <<'EOF'
export const PLATFORM_CHAT_PROVIDER_TOKENS = [] as const;
EOF
if run_check; then
  fail "an empty PLATFORM_CHAT_PROVIDER_TOKENS passed"
else
  pass "empty token list fails closed"
fi

exit "$FAILED"