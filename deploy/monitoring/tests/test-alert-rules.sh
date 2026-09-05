#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RULES="deploy/monitoring/alert.rules.yml"
TESTS="deploy/monitoring/tests/alert.rules.test.yml"
IMAGE="prom/prometheus:v2.55.1"

run_promtool() {
  if command -v promtool >/dev/null 2>&1; then
    promtool "$@"
    return
  fi

  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    docker run --rm -w /repo -v "${ROOT_DIR}:/repo:ro" "$IMAGE" promtool "$@"
    return
  fi

  echo "promtool or a running Docker daemon is required for monitoring rule tests" >&2
  exit 1
}

cd "$ROOT_DIR"
run_promtool check rules "$RULES"
run_promtool test rules "$TESTS"
