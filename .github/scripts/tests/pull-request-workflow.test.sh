#!/usr/bin/env bash
# Static regression tests for PR workflow secret scoping (#287).
set -euo pipefail

WORKFLOW=".github/workflows/pull-request.yml"
FAILED=0

fail() { echo "FAIL: $1" >&2; FAILED=1; }
pass() { echo "  ok: $1"; }

[ -f "$WORKFLOW" ] || { echo "FAIL: missing $WORKFLOW" >&2; exit 1; }

extract_job() {
  local job="$1"
  awk -v job="$job" '
    $0 == "  " job ":" { capture=1 }
    capture && $0 ~ /^  [A-Za-z0-9_-]+:/ && $0 != "  " job ":" { exit }
    capture { print }
  ' "$WORKFLOW"
}

extract_step() {
  local marker="$1"
  awk -v marker="$marker" '
    index($0, marker) { capture=1 }
    capture && $0 ~ /^      - name: / && index($0, marker) == 0 { exit }
    capture { print }
  ' "$WORKFLOW"
}

verify_job="$(extract_job verify)"
install_step="$(extract_step '      - name: Install dependencies')"
pr_verify_step="$(extract_step '      - name: Verify pull request')"
push_verify_step="$(extract_step '      - name: Verify trusted push')"
full_verify_step="$(extract_step '      - name: Verify full scheduled')"

printf '%s\n' "$verify_job" | grep -q '^    steps:' || fail "verify job has no steps"
job_header="$(printf '%s\n' "$verify_job" | awk '/^    steps:/{exit} {print}')"
! printf '%s\n' "$job_header" | grep -Eq 'TURBO_TOKEN|TURBO_TEAM' \
  || fail "Turbo credentials are present at verify job level"

printf '%s\n' "$install_step" | grep -q 'run: npm ci' || fail "npm ci step missing"
! printf '%s\n' "$install_step" | grep -Eq 'TURBO_TOKEN|TURBO_TEAM' \
  || fail "npm ci step receives Turbo credentials"

printf '%s\n' "$pr_verify_step" | grep -Fq "if: github.event_name == 'pull_request'" \
  || fail "PR verify is not gated by github.event_name == 'pull_request'"
printf '%s\n' "$pr_verify_step" | grep -q 'run: npm run verify:affected' \
  || fail "PR path does not run npm run verify:affected"
printf '%s\n' "$pr_verify_step" | grep -q 'TURBO_CONCURRENCY: 2' \
  || fail "PR path does not use Turbo concurrency 2"
! printf '%s\n' "$pr_verify_step" | grep -Eq 'TURBO_TOKEN|TURBO_TEAM|secrets\.' \
  || fail "PR verify path contains credentials"
pass "pull_request verify runs without Turbo credentials"

printf '%s\n' "$push_verify_step" | grep -Fq "if: github.event_name == 'push'" \
  || fail "trusted verify is not gated by github.event_name == 'push'"
printf '%s\n' "$push_verify_step" | grep -q 'run: npm run verify' \
  || fail "trusted push path does not run the cacheable Turbo verify"
! printf '%s\n' "$push_verify_step" | grep -q -- '--force' \
  || fail "trusted push path bypasses Turbo cache"
printf '%s\n' "$push_verify_step" | grep -q 'TURBO_TOKEN:.*secrets.TURBO_TOKEN' \
  || fail "trusted push path cannot use TURBO_TOKEN"
printf '%s\n' "$push_verify_step" | grep -q 'TURBO_TEAM:.*secrets.TURBO_TEAM' \
  || fail "trusted push path cannot use TURBO_TEAM"
printf '%s\n' "$push_verify_step" | grep -q 'TURBO_CONCURRENCY: 2' \
  || fail "trusted push path does not use Turbo concurrency 2"
pass "trusted push verify can use Turbo credentials"

printf '%s\n' "$full_verify_step" | grep -Fq "if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'" \
  || fail "full verify is not gated to scheduled/manual runs"
printf '%s\n' "$full_verify_step" | grep -q 'run: npx --no-install turbo run format:check lint typecheck test build --force' \
  || fail "scheduled path does not run the full forced Turbo verify"
printf '%s\n' "$full_verify_step" | grep -q 'TURBO_TOKEN:.*secrets.TURBO_TOKEN' \
  || fail "scheduled path cannot use TURBO_TOKEN"
printf '%s\n' "$full_verify_step" | grep -q 'TURBO_TEAM:.*secrets.TURBO_TEAM' \
  || fail "scheduled path cannot use TURBO_TEAM"
printf '%s\n' "$full_verify_step" | grep -q 'TURBO_CONCURRENCY: 2' \
  || fail "scheduled path does not use Turbo concurrency 2"
pass "scheduled/manual path retains a full uncached verify"

! grep -R --include='package.json' --exclude-dir=node_modules -q '"lint": "oxlint --fix"' apps packages \
  || fail "CI lint scripts still mutate source files"
pass "package lint scripts are check-only"

grep -q '^permissions:' "$WORKFLOW" || fail "workflow permissions block missing"
grep -q '^  contents: read$' "$WORKFLOW" || fail "workflow contents permission is not read-only"
! grep -Eq 'github\.actor|github\.event\.pull_request\.head\.repo\.fork|fork' "$WORKFLOW" \
  || fail "workflow uses fork/actor instead of event_name for Turbo scoping"
pass "workflow keeps read-only permissions and explicit event gating"

workflow_count=0
while IFS= read -r -d '' workflow; do
  workflow_count=$((workflow_count + 1))
  if grep -Eq '^  pull_request:' "$workflow"; then
    if ! grep -q '^  verify:' "$workflow"; then
      ! grep -Eq 'TURBO_TOKEN|TURBO_TEAM' "$workflow" \
        || fail "$workflow has pull_request without an isolated verify job and exposes Turbo credentials"
    fi
  fi
done < <(find .github/workflows -type f \( -name '*.yml' -o -name '*.yaml' \) -print0)
[ "$workflow_count" -gt 0 ] || fail "no workflow files were scanned"
pass "scanned all workflow files for pull_request paths"

[ "$FAILED" -eq 0 ] && echo "ALL TESTS PASSED"
exit "$FAILED"
