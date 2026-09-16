#!/usr/bin/env bash
# Regression tests for the PR evaluator self-scoring guard (#1238).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
CHECKER="$ROOT/.github/scripts/check-eval-rehash-pr.sh"
TMP_DIR="$(printenv TMPDIR || true)"
[ -n "$TMP_DIR" ] || TMP_DIR=/tmp
TMP_ROOT="$(mktemp -d "$TMP_DIR/eval-rehash-policy.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() { echo "FAIL: $1" >&2; exit 1; }
pass() { echo "  ok: $1"; }

OLD_HASH="$(printf 'a%.0s' {1..64})"
NEW_HASH="$(printf 'b%.0s' {1..64})"
EMPTY_LABELS='[]'
APPROVAL_LABEL='[{"name":"eval-rehash-approved"}]'

init_repo() {
  local repo=$1
  mkdir -p "$repo/packages/llm-agent/src" "$repo/packages/llm-agent/fixtures"
  git -C "$repo" init -q
  git -C "$repo" config user.email test@example.invalid
  git -C "$repo" config user.name "Eval Policy Test"
  git -C "$repo" config core.autocrlf false
  printf 'original prompt\n' > "$repo/packages/llm-agent/src/chat-system-prompt.ts"
  cat > "$repo/packages/llm-agent/fixtures/sample.json" <<EOF
{"name":"sample","coreHash":"$OLD_HASH","promptFiles":[{"path":"apps/messenger-bot/src/shared/prompts/messenger-chat.system.txt","hash":"$OLD_HASH"}]}
EOF
  git -C "$repo" add .
  git -C "$repo" commit -qm base
}

rewrite_hashes() {
  local file=$1
  local hash=$2
  EVAL_TEST_HASH="$hash" node - "$file" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const hash = process.env.EVAL_TEST_HASH;
const fixture = JSON.parse(fs.readFileSync(file, 'utf8'));
fixture.coreHash = hash;
fixture.promptFiles[0].hash = hash;
fs.writeFileSync(file, JSON.stringify(fixture) + '\n');
NODE
}

write_metadata() {
  local file=$1
  local base=$2
  local head=$3
  local labels=$4
  local reviews=$5
  printf '{"pullRequest":{"number":123,"user":{"login":"author"},"base":{"sha":"%s"},"head":{"sha":"%s"},"labels":%s},"reviews":%s}\n' \
    "$base" "$head" "$labels" "$reviews" > "$file"
}

approved_review() {
  printf '[{"state":"APPROVED","user":{"login":"reviewer"},"author_association":"MEMBER","submitted_at":"2026-09-16T00:00:00Z","commit_id":"%s"}]' "$1"
}

run_policy() {
  local repo=$1
  local base=$2
  local head=$3
  local metadata=$4
  local expected=$5
  local description=$6
  local output
  local status
  set +e
  output="$(EVAL_REHASH_BASE_SHA="$base" \
    EVAL_REHASH_HEAD_SHA="$head" \
    EVAL_REHASH_PR_NUMBER=123 \
    EVAL_REHASH_METADATA_FILE="$metadata" \
    bash "$CHECKER" "$repo" 2>&1)"
  status=$?
  set -e
  if [ "$expected" = pass ]; then
    [ "$status" -eq 0 ] || fail "$description: expected pass, got: $output"
    printf '%s\n' "$output" | grep -Fq 'EVAL REHASH POLICY: PASS' \
      || fail "$description: missing pass output"
  else
    [ "$status" -ne 0 ] || fail "$description: expected failure"
    printf '%s\n' "$output" | grep -Fq 'EVAL REHASH POLICY: FAIL' \
      || fail "$description: missing fail output"
  fi
  pass "$description"
}

make_combined() {
  local name=$1
  CASE_REPO="$TMP_ROOT/$name"
  init_repo "$CASE_REPO"
  CASE_BASE="$(git -C "$CASE_REPO" rev-parse HEAD)"
  printf 'changed prompt\n' > "$CASE_REPO/packages/llm-agent/src/chat-system-prompt.ts"
  rewrite_hashes "$CASE_REPO/packages/llm-agent/fixtures/sample.json" "$NEW_HASH"
  git -C "$CASE_REPO" add .
  git -C "$CASE_REPO" commit -qm "combined behavior and hash rewrite"
  CASE_HEAD="$(git -C "$CASE_REPO" rev-parse HEAD)"
}

make_behavior_only() {
  local name=$1
  CASE_REPO="$TMP_ROOT/$name"
  init_repo "$CASE_REPO"
  CASE_BASE="$(git -C "$CASE_REPO" rev-parse HEAD)"
  printf 'changed prompt\n' > "$CASE_REPO/packages/llm-agent/src/chat-system-prompt.ts"
  git -C "$CASE_REPO" add .
  git -C "$CASE_REPO" commit -qm "behavior only"
  CASE_HEAD="$(git -C "$CASE_REPO" rev-parse HEAD)"
}

make_hash_only() {
  local name=$1
  CASE_REPO="$TMP_ROOT/$name"
  init_repo "$CASE_REPO"
  CASE_BASE="$(git -C "$CASE_REPO" rev-parse HEAD)"
  rewrite_hashes "$CASE_REPO/packages/llm-agent/fixtures/sample.json" "$NEW_HASH"
  git -C "$CASE_REPO" add .
  git -C "$CASE_REPO" commit -qm "hash only"
  CASE_HEAD="$(git -C "$CASE_REPO" rev-parse HEAD)"
}

make_combined combined-no-approval
metadata="$TMP_ROOT/no-approval.json"
write_metadata "$metadata" "$CASE_BASE" "$CASE_HEAD" "$EMPTY_LABELS" '[]'
run_policy "$CASE_REPO" "$CASE_BASE" "$CASE_HEAD" "$metadata" fail \
  "combined behavior + hash rewrite without approval is rejected"

make_combined combined-label-only
metadata="$TMP_ROOT/label-only.json"
write_metadata "$metadata" "$CASE_BASE" "$CASE_HEAD" "$APPROVAL_LABEL" '[]'
run_policy "$CASE_REPO" "$CASE_BASE" "$CASE_HEAD" "$metadata" fail \
  "approval label without review is rejected"

make_combined combined-old-approval
metadata="$TMP_ROOT/old-approval.json"
write_metadata "$metadata" "$CASE_BASE" "$CASE_HEAD" "$APPROVAL_LABEL" "$(approved_review "$CASE_BASE")"
run_policy "$CASE_REPO" "$CASE_BASE" "$CASE_HEAD" "$metadata" fail \
  "approval for an older commit is rejected"

make_combined combined-approved
metadata="$TMP_ROOT/approved.json"
write_metadata "$metadata" "$CASE_BASE" "$CASE_HEAD" "$APPROVAL_LABEL" "$(approved_review "$CASE_HEAD")"
run_policy "$CASE_REPO" "$CASE_BASE" "$CASE_HEAD" "$metadata" pass \
  "label plus fresh trusted approval is accepted"

make_behavior_only behavior-only
metadata="$TMP_ROOT/behavior-only.json"
printf '{}\n' > "$metadata"
run_policy "$CASE_REPO" "$CASE_BASE" "$CASE_HEAD" "$metadata" pass \
  "behavior-only change is policy-clean"

make_hash_only hash-only
metadata="$TMP_ROOT/hash-only.json"
printf '{}\n' > "$metadata"
run_policy "$CASE_REPO" "$CASE_BASE" "$CASE_HEAD" "$metadata" pass \
  "hash-only change is policy-clean"

CASE_REPO="$TMP_ROOT/evaluator-and-hash"
init_repo "$CASE_REPO"
CASE_BASE="$(git -C "$CASE_REPO" rev-parse HEAD)"
mkdir -p "$CASE_REPO/packages/llm-agent/src/eval"
printf 'changed evaluator\n' > "$CASE_REPO/packages/llm-agent/src/eval/eval-harness.ts"
rewrite_hashes "$CASE_REPO/packages/llm-agent/fixtures/sample.json" "$NEW_HASH"
git -C "$CASE_REPO" add .
git -C "$CASE_REPO" commit -qm "evaluator and hash rewrite"
CASE_HEAD="$(git -C "$CASE_REPO" rev-parse HEAD)"
metadata="$TMP_ROOT/evaluator-and-hash.json"
write_metadata "$metadata" "$CASE_BASE" "$CASE_HEAD" "$EMPTY_LABELS" '[]'
run_policy "$CASE_REPO" "$CASE_BASE" "$CASE_HEAD" "$metadata" fail \
  "evaluator plus hash rewrite requires approval"

CASE_REPO="$TMP_ROOT/workflow-and-hash"
init_repo "$CASE_REPO"
CASE_BASE="$(git -C "$CASE_REPO" rev-parse HEAD)"
mkdir -p "$CASE_REPO/.github/workflows"
printf 'changed guardrail workflow\n' > "$CASE_REPO/.github/workflows/guardrail-battery.yml"
rewrite_hashes "$CASE_REPO/packages/llm-agent/fixtures/sample.json" "$NEW_HASH"
git -C "$CASE_REPO" add .
git -C "$CASE_REPO" commit -qm "workflow and hash rewrite"
CASE_HEAD="$(git -C "$CASE_REPO" rev-parse HEAD)"
metadata="$TMP_ROOT/workflow-and-hash.json"
write_metadata "$metadata" "$CASE_BASE" "$CASE_HEAD" "$EMPTY_LABELS" '[]'
run_policy "$CASE_REPO" "$CASE_BASE" "$CASE_HEAD" "$metadata" fail \
  "guardrail workflow plus hash rewrite requires approval"

make_combined malformed-metadata
metadata="$TMP_ROOT/malformed.json"
printf '{not json\n' > "$metadata"
run_policy "$CASE_REPO" "$CASE_BASE" "$CASE_HEAD" "$metadata" fail \
  "malformed pull request metadata fails closed"

make_combined missing-metadata
metadata="$TMP_ROOT/missing.json"
rm -f "$metadata"
run_policy "$CASE_REPO" "$CASE_BASE" "$CASE_HEAD" "$metadata" fail \
  "missing pull request metadata fails closed"

make_combined changes-requested
metadata="$TMP_ROOT/changes-requested.json"
reviews="$(printf '[{"state":"APPROVED","user":{"login":"reviewer"},"author_association":"MEMBER","submitted_at":"2026-09-16T00:00:00Z","commit_id":"%s"},{"state":"CHANGES_REQUESTED","user":{"login":"reviewer"},"author_association":"MEMBER","submitted_at":"2026-09-16T01:00:00Z","commit_id":"%s"}]' "$CASE_HEAD" "$CASE_HEAD")"
write_metadata "$metadata" "$CASE_BASE" "$CASE_HEAD" "$APPROVAL_LABEL" "$reviews"
run_policy "$CASE_REPO" "$CASE_BASE" "$CASE_HEAD" "$metadata" fail \
  "current-head changes requested revokes approval"

make_combined approval-with-comment
metadata="$TMP_ROOT/approval-with-comment.json"
reviews="$(printf '[{"state":"APPROVED","user":{"login":"reviewer"},"author_association":"MEMBER","submitted_at":"2026-09-16T00:00:00Z","commit_id":"%s"},{"state":"COMMENTED","user":{"login":"reviewer"},"author_association":"MEMBER","submitted_at":"2026-09-16T01:00:00Z","commit_id":"%s"}]' "$CASE_HEAD" "$CASE_HEAD")"
write_metadata "$metadata" "$CASE_BASE" "$CASE_HEAD" "$APPROVAL_LABEL" "$reviews"
run_policy "$CASE_REPO" "$CASE_BASE" "$CASE_HEAD" "$metadata" pass \
  "a later comment does not revoke approval"

CASE_REPO="$TMP_ROOT/added-fixture"
init_repo "$CASE_REPO"
CASE_BASE="$(git -C "$CASE_REPO" rev-parse HEAD)"
printf 'changed prompt\n' > "$CASE_REPO/packages/llm-agent/src/chat-system-prompt.ts"
cp "$CASE_REPO/packages/llm-agent/fixtures/sample.json" \
  "$CASE_REPO/packages/llm-agent/fixtures/added.json"
git -C "$CASE_REPO" add .
git -C "$CASE_REPO" commit -qm "add fixture with behavior"
CASE_HEAD="$(git -C "$CASE_REPO" rev-parse HEAD)"
metadata="$TMP_ROOT/added-fixture.json"
write_metadata "$metadata" "$CASE_BASE" "$CASE_HEAD" "$EMPTY_LABELS" '[]'
run_policy "$CASE_REPO" "$CASE_BASE" "$CASE_HEAD" "$metadata" fail \
  "new fixture with behavior change is rejected"

CASE_REPO="$TMP_ROOT/renamed-fixture"
init_repo "$CASE_REPO"
CASE_BASE="$(git -C "$CASE_REPO" rev-parse HEAD)"
printf 'changed prompt\n' > "$CASE_REPO/packages/llm-agent/src/chat-system-prompt.ts"
git -C "$CASE_REPO" mv packages/llm-agent/fixtures/sample.json packages/llm-agent/fixtures/renamed.json
git -C "$CASE_REPO" add .
git -C "$CASE_REPO" commit -qm "rename fixture with behavior"
CASE_HEAD="$(git -C "$CASE_REPO" rev-parse HEAD)"
metadata="$TMP_ROOT/renamed-fixture.json"
write_metadata "$metadata" "$CASE_BASE" "$CASE_HEAD" "$EMPTY_LABELS" '[]'
run_policy "$CASE_REPO" "$CASE_BASE" "$CASE_HEAD" "$metadata" fail \
  "fixture rename with behavior change is rejected"

CASE_REPO="$TMP_ROOT/deleted-fixture"
init_repo "$CASE_REPO"
CASE_BASE="$(git -C "$CASE_REPO" rev-parse HEAD)"
printf 'changed prompt\n' > "$CASE_REPO/packages/llm-agent/src/chat-system-prompt.ts"
rm "$CASE_REPO/packages/llm-agent/fixtures/sample.json"
git -C "$CASE_REPO" add .
git -C "$CASE_REPO" commit -qm "delete fixture with behavior"
CASE_HEAD="$(git -C "$CASE_REPO" rev-parse HEAD)"
metadata="$TMP_ROOT/deleted-fixture.json"
write_metadata "$metadata" "$CASE_BASE" "$CASE_HEAD" "$EMPTY_LABELS" '[]'
run_policy "$CASE_REPO" "$CASE_BASE" "$CASE_HEAD" "$metadata" fail \
  "fixture deletion with behavior change is rejected"

CASE_REPO="$TMP_ROOT/malformed-fixture"
init_repo "$CASE_REPO"
CASE_BASE="$(git -C "$CASE_REPO" rev-parse HEAD)"
printf 'changed prompt\n' > "$CASE_REPO/packages/llm-agent/src/chat-system-prompt.ts"
printf '{not json\n' > "$CASE_REPO/packages/llm-agent/fixtures/sample.json"
git -C "$CASE_REPO" add .
git -C "$CASE_REPO" commit -qm "malformed fixture"
CASE_HEAD="$(git -C "$CASE_REPO" rev-parse HEAD)"
metadata="$TMP_ROOT/malformed-fixture.json"
printf '{}\n' > "$metadata"
run_policy "$CASE_REPO" "$CASE_BASE" "$CASE_HEAD" "$metadata" fail \
  "malformed fixture metadata fails closed"

CASE_REPO="$TMP_ROOT/incomplete-fixture"
init_repo "$CASE_REPO"
CASE_BASE="$(git -C "$CASE_REPO" rev-parse HEAD)"
printf 'changed prompt\n' > "$CASE_REPO/packages/llm-agent/src/chat-system-prompt.ts"
printf '{"name":"sample","promptFiles":[]}\n' > "$CASE_REPO/packages/llm-agent/fixtures/sample.json"
git -C "$CASE_REPO" add .
git -C "$CASE_REPO" commit -qm "incomplete fixture metadata"
CASE_HEAD="$(git -C "$CASE_REPO" rev-parse HEAD)"
metadata="$TMP_ROOT/incomplete-fixture.json"
printf '{}\n' > "$metadata"
run_policy "$CASE_REPO" "$CASE_BASE" "$CASE_HEAD" "$metadata" fail \
  "incomplete fixture hash metadata fails closed"

POLICY_WORKFLOW="$ROOT/.github/workflows/eval-rehash-policy.yml"
[ -f "$POLICY_WORKFLOW" ] || fail "policy workflow is missing"
grep -q '^  pull_request:$' "$POLICY_WORKFLOW" \
  || fail "policy workflow does not listen for pull_request"
grep -q '^  pull_request_review:$' "$POLICY_WORKFLOW" \
  || fail "policy workflow does not listen for pull_request_review"
for event_type in opened reopened synchronize labeled unlabeled ready_for_review submitted edited dismissed; do
  grep -q -- "- $event_type" "$POLICY_WORKFLOW" \
    || fail "policy workflow is missing event type $event_type"
done
grep -q '^  contents: read$' "$POLICY_WORKFLOW" \
  || fail "policy workflow contents permission is not read-only"
grep -q '^  pull-requests: read$' "$POLICY_WORKFLOW" \
  || fail "policy workflow pull-request permission is not read-only"
! grep -q 'pull_request_target' "$POLICY_WORKFLOW" \
  || fail "policy workflow uses privileged pull_request_target"
grep -q 'git show "\$EVAL_REHASH_BASE_SHA:.github/scripts/check-eval-rehash-pr.js"' "$POLICY_WORKFLOW" \
  || fail "policy workflow does not load the checker from the base revision"
grep -q 'node "\$trusted_checker" "\$GITHUB_WORKSPACE"' "$POLICY_WORKFLOW" \
  || fail "policy workflow does not run the trusted checker"
grep -q 'env -u GITHUB_TOKEN node .github/scripts/check-eval-rehash-pr.js' "$POLICY_WORKFLOW" \
  || fail "bootstrap policy path does not remove the token"
! grep -q '\\\${{' "$POLICY_WORKFLOW" \
  || fail "policy workflow contains escaped GitHub expressions"
grep -Fq 'ref: ${{ github.event.pull_request.head.sha }}' "$POLICY_WORKFLOW" \
  || fail "policy workflow does not check out the pull request head"
pass "policy workflow is lightweight, read-only, and reruns on review metadata"

echo "ALL TESTS PASSED"
