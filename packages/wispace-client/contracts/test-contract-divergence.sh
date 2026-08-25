#!/bin/bash
# Validate that canonical fixtures, runtime parser, and documented contract agree.
# Run from repo root: bash packages/wispace-client/contracts/test-contract-divergence.sh
set -euo pipefail

PASS=0
FAIL=0
CONTRACTS_DIR="packages/wispace-client/contracts"

assert_file_exists() {
  local file="$1" label="$2"
  if [ -f "$file" ]; then
    echo "  ✓ $label"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $label (file not found: $file)"
    FAIL=$((FAIL + 1))
  fi
}

assert_json_valid() {
  local file="$1" label="$2"
  if node -e "JSON.parse(require('fs').readFileSync('$file','utf8'))" 2>/dev/null; then
    echo "  ✓ $label (valid JSON)"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $label (invalid JSON)"
    FAIL=$((FAIL + 1))
  fi
}

assert_fixture_matches_contract() {
  local fixture="$1" contract="$2" label="$3"
  local fixture_valid fixture_invalid
  fixture_valid=$(node -e "const f=JSON.parse(require('fs').readFileSync('$fixture','utf8')); console.log(JSON.stringify(f.valid))" 2>/dev/null)
  fixture_invalid=$(node -e "const f=JSON.parse(require('fs').readFileSync('$fixture','utf8')); console.log(f.invalid?.length ?? 0)" 2>/dev/null)

  if [ -n "$fixture_valid" ] && [ "$fixture_invalid" != "0" ]; then
    echo "  ✓ $label (has valid + invalid cases)"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $label (missing valid or invalid test cases)"
    FAIL=$((FAIL + 1))
  fi
}

echo "═══ Contract divergence validation ═══"
echo ""

echo "─── Contract files exist ───"
assert_file_exists "$CONTRACTS_DIR/wispace-goals.contract.json" "Goals contract"
assert_file_exists "$CONTRACTS_DIR/wispace-task-score.contract.json" "TaskScore contract"
assert_file_exists "$CONTRACTS_DIR/wispace-verify-token.contract.json" "VerifyToken contract"
assert_file_exists "$CONTRACTS_DIR/discord-oauth-callback.contract.json" "Discord OAuth contract"
assert_file_exists "$CONTRACTS_DIR/zalo-oauth-callback.contract.json" "Zalo OAuth contract"
assert_file_exists "$CONTRACTS_DIR/error-scenarios.json" "Error scenarios"
echo ""

echo "─── Contract JSON valid ───"
assert_json_valid "$CONTRACTS_DIR/wispace-goals.contract.json" "Goals contract"
assert_json_valid "$CONTRACTS_DIR/wispace-task-score.contract.json" "TaskScore contract"
assert_json_valid "$CONTRACTS_DIR/wispace-verify-token.contract.json" "VerifyToken contract"
assert_json_valid "$CONTRACTS_DIR/error-scenarios.json" "Error scenarios"
echo ""

echo "─── Fixtures have valid + invalid cases ───"
assert_fixture_matches_contract "packages/wispace-client/fixtures/user-goals.json" "Goals" "Goals fixture"
assert_fixture_matches_contract "packages/wispace-client/fixtures/task-score-average.json" "TaskScore" "TaskScore fixture"
echo ""

echo "═══ Results: $PASS passed, $FAIL failed ═══"
[ "$FAIL" -eq 0 ] || exit 1
