#!/usr/bin/env bash
set -euo pipefail

# VPS-side self-pull deploy: run this via VPS cron, NOT from GitHub Actions.
# The VPS pulls the repo + image itself (outbound to GitHub/GHCR), so it
# never depends on inbound SSH from a GitHub Actions runner IP — the
# provider's edge network intermittently drops those regardless of port
# or retry count (see docs/project-overview.md §12).
#
# One-time VPS setup:
#   git clone https://github.com/lengocanh2005it/wispace-bot.git ~/wispace-bot-src
#   crontab -e
#   # ~/.ghcr-token is mode 600 and contains GHCR_USER, GHCR_PULL_TOKEN, and
#   # GITHUB_API_READ_TOKEN (a separate fine-grained, read-only Actions/Checks token).
#   # Install jq on the VPS; the self-pull CI gate fails closed without it.
#   */2 * * * * cd ~/wispace-bot-src && source ~/.ghcr-token && \
#     bash .github/scripts/vps-self-pull-deploy.sh >> ~/vps-self-pull-deploy.log 2>&1
#
# The git fetch + reset run INSIDE this script, after the deploy lock is held
# (#172): a concurrent cron tick can never reset the checkout mid-deploy.
# Any failure before the deploy loop (fetch, reset, stale checkout, missing
# clone dir) fails closed with a timestamped ERROR, a stall marker and a
# Telegram alert via the local Alertmanager (default route) instead of
# silently stalling (#144); the next cron tick retries.
#
# Each app directory keeps only its Vault bootstrap `.env`. This script
# validates that bootstrap before rolling an image forward; runtime secrets
# are fetched by the container during startup.

REPO_DIR="${REPO_DIR:-$HOME/wispace-bot-src}"
STATE_DIR="${STATE_DIR:-$HOME/.vps-deploy-state}"
LOCK_FILE="${LOCK_FILE:-/tmp/vps-self-pull-deploy.lock}"
REGISTRY="ghcr.io"
REPO_LC="lengocanh2005it/wispace-bot"
NGINX_UPSTREAM_DIR="${NGINX_UPSTREAM_DIR:-/home/ngoc_anh/infra/nginx/upstreams}"
APP_NETWORK="${APP_NETWORK:-app_n8n_db_network}"
MIGRATION_LOCK_ID="${MIGRATION_LOCK_ID:-4242424242}"
TARGET_BASE_DIR="${TARGET_BASE_DIR:-/home/ngoc_anh}"
ALERTMANAGER_URL="${ALERTMANAGER_URL:-http://127.0.0.1:9093}"
CI_GATE_WAIT_TIMEOUT_SECONDS="${CI_GATE_WAIT_TIMEOUT_SECONDS:-1800}"
STALL_ALERT="vps_self_pull_stall"
APP_FAIL_ALERT="vps_self_pull_app_failed"
STALL_MARKER="$STATE_DIR/stall"
# How far back to look for a commit that actually produced images.
RESOLVE_DEPTH="${RESOLVE_DEPTH:-20}"
# Revision whose migrations the owner has applied, and the tree the barrier
# compares against to decide whether the schema is already current (#695).
SCHEMA_STATE_FILE="$STATE_DIR/schema.sha"
MIGRATIONS_PATH="${MIGRATIONS_PATH:-packages/database/src/migrations}"
CI_GATE_STATE_DIR="$STATE_DIR/ci-gate"

: "${GHCR_USER:?GHCR_USER is required}"
: "${GHCR_PULL_TOKEN:?GHCR_PULL_TOKEN is required}"

mkdir -p "$STATE_DIR"
mkdir -p "$CI_GATE_STATE_DIR"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "Another self-pull run is still in progress — skipping"
  exit 0
fi

current_sha() {
  git rev-parse HEAD 2>/dev/null || echo unknown
}

post_alert() { # alertname annotations_json [ends_at]
  local alertname="$1"
  local body="[{\"labels\":{\"alertname\":\"$alertname\",\"severity\":\"critical\"},\"annotations\":$2"
  if [ -n "${3:-}" ]; then body="$body,\"endsAt\":\"$3\""; fi
  body="$body}]"
  curl -sf -X POST "$ALERTMANAGER_URL/api/v2/alerts" \
    -H 'Content-Type: application/json' \
    -d "$body" \
    >/dev/null 2>&1
}

notify_stall() { # summary description
  local summary="$1" detail="$2"
  post_alert "$STALL_ALERT" "{\"summary\":\"$summary\",\"description\":\"$detail\"}" \
    || echo "WARN [$(date -Is)] Alertmanager notify failed (curl)" >&2
}

resolve_stall() {
  post_alert "$STALL_ALERT" "{}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    || echo "WARN [$(date -Is)] Alertmanager resolve notify failed (curl)" >&2
}

notify_app_failed() { # app sha [reason]
  local app="$1" sha="$2" reason="${3:-deploy failed}"
  post_alert "$APP_FAIL_ALERT" "{\"summary\":\"$app deploy failed\",\"description\":\"$app @ $sha failed at $(date -Is): $reason; next cron tick retries.\"}" \
    || echo "WARN [$(date -Is)] Alertmanager notify failed (curl)" >&2
}

validate_bootstrap_env() { # app directory
  local file="$1/.env"
  [ -f "$file" ] || return 1
  chmod 600 "$file" 2>/dev/null || return 1
  grep -q '^VAULT_REQUIRED=true$' "$file" || return 1
  grep -q '^VAULT_ADDR=https://' "$file" || return 1
  grep -Eq '^VAULT_ROLE_ID=.+$' "$file" || return 1
  grep -Eq '^VAULT_SECRET_ID=.+$' "$file" || return 1
}

resolve_app_failed() { # app
  post_alert "$APP_FAIL_ALERT" "{}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    || echo "WARN [$(date -Is)] Alertmanager resolve notify failed (curl)" >&2
}

write_stall_marker() { # reason
  echo "$(date -Is) $1 $(current_sha)" > "$STALL_MARKER"
}

stall_exit() { # reason summary detail
  local reason="$1" summary="$2" detail="$3"
  echo "ERROR [$(date -Is)] $reason" >&2
  write_stall_marker "$reason"
  notify_stall "$summary" "$detail"
  exit 1
}

CI_TMP_DIR=""
CI_GLOBAL_STATE="pass"
CI_GLOBAL_REASON=""
CI_APP_FAILURE_COUNT=0
CI_APP_PENDING_COUNT=0
declare -A CI_APP_STATE=()
declare -A CI_APP_BUILD=()
declare -A CI_APP_REASON=()
declare -A CI_JOB_STATUS=()
declare -A CI_JOB_CONCLUSION=()

github_api_get() { # endpoint output_file -> 0 success, 20 transient, 21 auth/unknown, 22 not found
  local endpoint="$1" output_file="$2" url http_code curl_rc=0
  local auth_header="$CI_TMP_DIR/github-api-auth.header" response_headers="$CI_TMP_DIR/github-api.headers"
  url="https://api.github.com/repos/$REPO_LC/$endpoint"
  if [ ! -s "$auth_header" ]; then
    (umask 077; printf 'Authorization: Bearer %s\n' "$GITHUB_API_READ_TOKEN" > "$auth_header") || return 20
  fi
  : > "$output_file"
  http_code="$(curl -sS --connect-timeout 10 --max-time 30 -D "$response_headers" -o "$output_file" -w '%{http_code}' \
    -H "@$auth_header" \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' \
    "$url" 2>/dev/null)" || curl_rc=$?
  [ "$curl_rc" -eq 0 ] || return 20
  case "${http_code:-000}" in
    200) return 0 ;;
    401) return 21 ;;
    403)
      if grep -qiE 'rate[ -]?limit|retry-after:[[:space:]]*0|x-ratelimit-remaining:[[:space:]]*0' \
        "$output_file" "$response_headers" 2>/dev/null; then
        return 20
      fi
      return 21
      ;;
    404) return 22 ;;
    408|425|429|500|502|503|504|000) return 20 ;;
    *) return 21 ;;
  esac
}

ci_get_run_record() { # workflow_file sha record_file -> result code
  local workflow_file="$1" sha="$2" record_file="$3"
  local response_file="$CI_TMP_DIR/runs-${workflow_file//\//_}.json" rc=0 record=""
  github_api_get "actions/workflows/$workflow_file/runs?head_sha=$sha&event=push&branch=main&per_page=20" "$response_file" || rc=$?
  [ "$rc" -eq 0 ] || return "$rc"
  jq -e 'type == "object" and (.workflow_runs | type == "array")' "$response_file" >/dev/null 2>&1 || return 23
  record="$(jq -r --arg sha "$sha" '
    [
      .workflow_runs[]?
      | select(.head_sha == $sha and .event == "push" and (.head_branch // .base_branch) == "main")
    ]
    | sort_by([(.run_number // 0), (.run_attempt // 0), (.created_at // "")])
    | last
    | if . == null then empty
      else [(.id | tostring), (.status // ""), (.conclusion // "")] | @tsv
      end
  ' "$response_file" 2>/dev/null)" || return 23
  [ -n "$record" ] || return 22
  printf '%s\n' "$record" > "$record_file" || return 20
}

ci_get_jobs() { # run_id jobs_file -> result code
  local run_id="$1" jobs_file="$2"
  local response_file="$CI_TMP_DIR/jobs-$run_id.json" rc=0
  github_api_get "actions/runs/$run_id/jobs?per_page=100" "$response_file" || rc=$?
  [ "$rc" -eq 0 ] || return "$rc"
  jq -e 'type == "object" and (.jobs | type == "array")' "$response_file" >/dev/null 2>&1 || return 23
  cp "$response_file" "$jobs_file" || return 20
}

ci_load_job_map() { # jobs_file
  local jobs_file="$1" rows=""
  CI_JOB_STATUS=()
  CI_JOB_CONCLUSION=()
  rows="$(jq -r '.jobs[]? | [(.name // ""), (.status // ""), (.conclusion // "")] | @tsv' "$jobs_file" 2>/dev/null)" || return 23
  local name status conclusion
  while IFS=$'\t' read -r name status conclusion; do
    [ -n "$name" ] || continue
    CI_JOB_STATUS["$name"]="$status"
    CI_JOB_CONCLUSION["$name"]="$conclusion"
  done <<< "$rows"
}

ci_job_state() { # job_name -> success|skipped|pending|failed|missing
  local job_name="$1" status conclusion
  status="${CI_JOB_STATUS[$job_name]-}"
  conclusion="${CI_JOB_CONCLUSION[$job_name]-}"
  if [ -z "$status" ]; then
    printf 'missing'
  elif [ "$status" != "completed" ]; then
    printf 'pending'
  elif [ "$conclusion" = "success" ]; then
    printf 'success'
  elif [ "$conclusion" = "skipped" ]; then
    printf 'skipped'
  else
    printf 'failed'
  fi
}

ci_set_app_state() {
  local app="$1" state="$2" reason="$3"
  CI_APP_STATE["$app"]="$state"
  CI_APP_REASON["$app"]="$reason"
}

ci_mark_global_pending() {
  [ "$CI_GLOBAL_STATE" = "failed" ] || CI_GLOBAL_STATE="pending"
  [ -n "$CI_GLOBAL_REASON" ] || CI_GLOBAL_REASON="$1"
}

ci_mark_global_failed() {
  CI_GLOBAL_STATE="failed"
  CI_GLOBAL_REASON="$1"
}

ci_evaluate_verify() {
  local record_file="$CI_TMP_DIR/verify-run.tsv" jobs_file="$CI_TMP_DIR/verify-jobs.tsv" rc=0 record=""
  ci_get_run_record "pull-request.yml" "$HEAD_SHA" "$record_file" || rc=$?
  case "$rc" in
    21) ci_mark_global_failed "Verify Pull Request API authorization failed"; return ;;
    20|22|23) ci_mark_global_pending "Verify Pull Request result is not available"; return ;;
  esac
  record="$(cat "$record_file")"
  local run_id run_status run_conclusion
  IFS=$'\t' read -r run_id run_status run_conclusion <<< "$record"
  if [ "$run_status" != "completed" ]; then
    ci_mark_global_pending "Verify Pull Request is $run_status"
    return
  fi
  if [ "$run_conclusion" != "success" ]; then
    ci_mark_global_failed "Verify Pull Request concluded $run_conclusion"
    return
  fi
  ci_get_jobs "$run_id" "$jobs_file" || rc=$?
  case "$rc" in
    21) ci_mark_global_failed "Verify Pull Request jobs API authorization failed"; return ;;
    20|22|23) ci_mark_global_pending "Verify Pull Request jobs are not available"; return ;;
  esac
  ci_load_job_map "$jobs_file" || { ci_mark_global_pending "Verify Pull Request jobs are malformed"; return; }
  case "$(ci_job_state verify)" in
    success) ;;
    pending) ci_mark_global_pending "Verify Pull Request verify job is still running" ;;
    skipped) ci_mark_global_failed "Verify Pull Request verify job was skipped" ;;
    *) ci_mark_global_failed "Verify Pull Request verify job is unavailable or failed" ;;
  esac
}

ci_evaluate_app() { # app
  local app="$1" prefix state required
  prefix="deploy-$app /"
  CI_APP_BUILD["$app"]="unknown"
  state="$(ci_job_state "$prefix changes")"
  case "$state" in
    success) ;;
    pending) ci_set_app_state "$app" pending "$prefix changes is still running"; return ;;
    *) ci_set_app_state "$app" failed "$prefix changes is $state"; return ;;
  esac

  state="$(ci_job_state "$prefix build-image")"
  case "$state" in
    skipped)
      CI_APP_BUILD["$app"]="skipped"
      ci_set_app_state "$app" pass "build skipped by the CI path filter"
      return
      ;;
    pending)
      ci_set_app_state "$app" pending "$prefix build-image is still running"
      return
      ;;
    success)
      CI_APP_BUILD["$app"]="success"
      ;;
    *)
      ci_set_app_state "$app" failed "$prefix build-image is $state"
      return
      ;;
  esac

  state="$(ci_job_state "$prefix runtime-image-check")"
  case "$state" in
    success) ;;
    pending) ci_set_app_state "$app" pending "$prefix runtime-image-check is still running"; return ;;
    *) ci_set_app_state "$app" failed "$prefix runtime-image-check is $state"; return ;;
  esac
  if [ "$app" = "messenger-bot" ]; then
    for required in migration-timestamps migrations-check; do
      state="$(ci_job_state "$prefix $required")"
      case "$state" in
        success) ;;
        pending) ci_set_app_state "$app" pending "$prefix $required is still running"; return ;;
        *) ci_set_app_state "$app" failed "$prefix $required is $state"; return ;;
      esac
    done
  fi
  ci_set_app_state "$app" pass "all required CI jobs passed"
}

ci_evaluate_deploy() {
  local record_file="$CI_TMP_DIR/deploy-run.tsv" jobs_file="$CI_TMP_DIR/deploy-jobs.json" rc=0 record=""
  ci_get_run_record "deploy-bots.yml" "$HEAD_SHA" "$record_file" || rc=$?
  case "$rc" in
    21) ci_mark_global_failed "Deploy bots API authorization failed"; return ;;
    20|22|23) ci_mark_global_pending "Deploy bots result is not available"; return ;;
  esac
  record="$(cat "$record_file")"
  local run_id run_status run_conclusion
  IFS=$'\t' read -r run_id run_status run_conclusion <<< "$record"
  if [ "$run_status" != "completed" ]; then
    ci_mark_global_pending "Deploy bots is $run_status"
    return
  fi
  case "$run_conclusion" in
    success|failure) ;;
    *) ci_mark_global_failed "Deploy bots concluded ${run_conclusion:-without a conclusion}"; return ;;
  esac
  ci_get_jobs "$run_id" "$jobs_file" || rc=$?
  case "$rc" in
    21) ci_mark_global_failed "Deploy bots jobs API authorization failed"; return ;;
    20|22|23) ci_mark_global_pending "Deploy bots jobs are not available"; return ;;
  esac
  ci_load_job_map "$jobs_file" || { ci_mark_global_pending "Deploy bots jobs are malformed"; return; }

  CI_APP_FAILURE_COUNT=0
  CI_APP_PENDING_COUNT=0
  local app
  for app in "${APP_ORDER[@]}"; do
    ci_evaluate_app "$app"
    case "${CI_APP_STATE[$app]}" in
      failed)
        CI_APP_FAILURE_COUNT=$((CI_APP_FAILURE_COUNT + 1))
        [ "$app" = "messenger-bot" ] && ci_mark_global_failed "${CI_APP_REASON[$app]}"
        ;;
      pending)
        CI_APP_PENDING_COUNT=$((CI_APP_PENDING_COUNT + 1))
        [ "$app" = "messenger-bot" ] && ci_mark_global_pending "${CI_APP_REASON[$app]}"
        ;;
    esac
  done
  if [ "$run_conclusion" != "success" ] && [ "$CI_APP_FAILURE_COUNT" -eq 0 ]; then
    ci_mark_global_failed "Deploy bots concluded $run_conclusion without an attributable app job"
  fi
}

ci_evaluate_all() {
  CI_GLOBAL_STATE="pass"
  CI_GLOBAL_REASON=""
  CI_APP_STATE=()
  CI_APP_BUILD=()
  CI_APP_REASON=()
  ci_evaluate_verify
  [ "$CI_GLOBAL_STATE" = "pass" ] || return 0
  ci_evaluate_deploy
}

ci_wait_for_retry() { # reason -> 0 while within wait budget, 1 after timeout
  local reason="$1" marker="$CI_GATE_STATE_DIR/$HEAD_SHA.pending" timeout_marker="$CI_GATE_STATE_DIR/$HEAD_SHA.stalled"
  local now first_seen age
  now="$(date +%s)"
  if [ ! -f "$marker" ]; then
    printf '%s\n%s\n' "$now" "$reason" > "$marker"
    first_seen="$now"
  else
    first_seen="$(head -n 1 "$marker" 2>/dev/null || true)"
    if ! [[ "$first_seen" =~ ^[0-9]+$ ]]; then
      first_seen="$now"
      printf '%s\n%s\n' "$now" "$reason" > "$marker"
    fi
  fi
  age=$((now - first_seen))
  if [ "$age" -ge "$CI_GATE_WAIT_TIMEOUT_SECONDS" ]; then
    if [ ! -f "$timeout_marker" ]; then
      printf '%s\n%s\n' "$now" "$reason" > "$timeout_marker"
      notify_stall "VPS self-pull CI gate timed out" "CI for $HEAD_SHA stayed unavailable for ${age}s: $reason"
    fi
    write_stall_marker "ci_gate_timeout $HEAD_SHA"
    echo "ERROR [$(date -Is)] CI gate timed out for $HEAD_SHA after ${age}s: $reason" >&2
    return 1
  fi
  echo "CI gate pending for $HEAD_SHA (${age}s/${CI_GATE_WAIT_TIMEOUT_SECONDS}s): $reason"
  return 0
}

ci_fail_global() { # reason
  local reason="$1" marker="$CI_GATE_STATE_DIR/$HEAD_SHA.failed"
  if [ ! -f "$marker" ] || [ "$(head -n 1 "$marker" 2>/dev/null || true)" != "$HEAD_SHA" ]; then
    printf '%s\n%s\n' "$HEAD_SHA" "$reason" > "$marker"
    notify_stall "VPS self-pull CI gate failed" "CI gate blocked $HEAD_SHA: $reason"
  fi
  write_stall_marker "ci_gate_failed $HEAD_SHA"
  echo "ERROR [$(date -Is)] CI gate blocked for $HEAD_SHA: $reason" >&2
  return 1
}

ci_mark_app_failure() { # app reason
  local app="$1" reason="$2" marker
  marker="$CI_GATE_STATE_DIR/$app.failed"
  if [ ! -f "$marker" ] || [ "$(head -n 1 "$marker" 2>/dev/null || true)" != "$HEAD_SHA" ]; then
    printf '%s\n%s\n' "$HEAD_SHA" "$reason" > "$marker"
    notify_app_failed "$app" "$HEAD_SHA" "CI gate failed: $reason"
  fi
}

ci_clear_app_failure() { # app
  local app="$1" marker
  marker="$CI_GATE_STATE_DIR/$app.failed"
  if [ -f "$marker" ]; then
    rm -f "$marker"
    [ -f "$STATE_DIR/$app.failed" ] || resolve_app_failed "$app"
  fi
}

ci_clear_current_state() {
  rm -f "$CI_GATE_STATE_DIR/$HEAD_SHA.pending" "$CI_GATE_STATE_DIR/$HEAD_SHA.stalled" "$CI_GATE_STATE_DIR/$HEAD_SHA.failed"
}

recover_previous_stall() {
  if [ -f "$STALL_MARKER" ]; then
    echo "Recovered from previous stall ($(cat "$STALL_MARKER"))"
    rm -f "$STALL_MARKER"
    resolve_stall
  fi
}

if ! cd "$REPO_DIR"; then
  stall_exit "repo dir missing ($REPO_DIR)" \
    "VPS self-pull stalled (repo dir missing)" \
    "$REPO_DIR does not exist at $(date -Is) — re-clone per docs/project-overview.md §12."
fi

if ! git fetch origin main; then
  stall_exit "git fetch origin main failed — staying on $(current_sha)" \
    "VPS self-pull stalled (git fetch failed)" \
    "git fetch origin main failed at $(date -Is); repo stays at $(current_sha); next cron tick retries."
fi

if ! git reset --hard origin/main; then
  stall_exit "git reset --hard origin/main failed" \
    "VPS self-pull stalled (git reset failed)" \
    "git reset failed at $(date -Is) after fetch; repo at $(current_sha)."
fi

if [ "$(git rev-parse HEAD 2>/dev/null)" != "$(git rev-parse origin/main 2>/dev/null)" ]; then
  stall_exit "checkout stale: HEAD=$(current_sha) origin/main=$(git rev-parse origin/main 2>/dev/null || echo unknown)" \
    "VPS self-pull stalled (stale checkout)" \
    "HEAD != origin/main after reset at $(date -Is)."
fi

NEW_SHA=$(current_sha)
HEAD_SHA="$NEW_SHA"

if [ -z "${GITHUB_API_READ_TOKEN:-}" ]; then
  ci_fail_global "GITHUB_API_READ_TOKEN is required for the CI gate" || exit 1
fi
if ! [[ "$CI_GATE_WAIT_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  ci_fail_global "CI_GATE_WAIT_TIMEOUT_SECONDS must be a positive integer" || exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  ci_fail_global "jq is required for the GitHub Actions CI gate" || exit 1
fi
if ! CI_TMP_DIR="$(mktemp -d)"; then
  ci_fail_global "could not create a temporary directory for the CI gate" || exit 1
fi
trap 'rm -rf -- "$CI_TMP_DIR"' EXIT

# A missing image is expected only when the exact CI build job was skipped.
image_missing_cause() {
  printf 'not published yet (CI build was skipped for this sha)'
}

# The barrier's question is whether the shared schema is at the revision this
# release expects — not whether an image happens to exist (#695). The owner
# records the revision whose migrations it has applied; deployments that
# predate this file fall back to the owner's own state file.
schema_revision() {
  if [ -s "$SCHEMA_STATE_FILE" ]; then
    cat "$SCHEMA_STATE_FILE"
  elif [ -s "$STATE_DIR/${APP_ORDER[0]}.sha" ]; then
    cat "$STATE_DIR/${APP_ORDER[0]}.sha"
  fi
}

record_schema_revision() { # run_migrations sha
  [ "$1" = "true" ] || return 0
  printf %s "$2" > "$SCHEMA_STATE_FILE"
}

# True when the applied revision is an ancestor of the target and no migration
# was added between them: the schema is already where this release needs it,
# so a missing owner image is not a reason to hold the dependent bots back.
schema_current_for() { # target_sha
  local applied
  applied=$(schema_revision)
  [ -n "$applied" ] || return 1
  [ "$applied" = "$1" ] && return 0
  git merge-base --is-ancestor "$applied" "$1" >/dev/null 2>&1 || return 1
  ! git diff --name-only "$applied" "$1" -- "$MIGRATIONS_PATH" 2>/dev/null | grep -q .
}

# app -> "health_path:run_migrations"
declare -A APPS=(
  [messenger-bot]="/health/ready:true"
  [discord-bot]="/health/ready:false"
  [zalo-bot]="/health/ready:false"
)

APP_ORDER=(messenger-bot discord-bot zalo-bot)

deploy_app() {
  local app="$1"
  local is_migration_owner="${2:-false}"
  local health_path run_migrations target_dir image state_file fail_marker image_digest migration_cmd
  IFS=':' read -r health_path run_migrations <<< "${APPS[$app]}"
  target_dir="$TARGET_BASE_DIR/${app}"
  image="${REGISTRY}/${REPO_LC}/${app}:${NEW_SHA}"
  state_file="$STATE_DIR/${app}.sha"
  fail_marker="$STATE_DIR/${app}.failed"

  if ! validate_bootstrap_env "$target_dir"; then
    echo "ERROR: $app has no valid Vault bootstrap — refusing to deploy" >&2
    return 1
  fi

  if [ -f "$state_file" ] && [ "$(cat "$state_file")" = "$NEW_SHA" ]; then
    record_schema_revision "$run_migrations" "$NEW_SHA"
    return 0
  fi

  if ! docker manifest inspect "$image" >/dev/null 2>&1; then
    if [ "$is_migration_owner" = "true" ]; then
      # A success/image contradiction is authoritative only for HEAD; a
      # fleet-wide fallback target belongs to the open per-app resolution gap.
      if [ "${CI_APP_BUILD[$app]-unknown}" = "success" ] && [ "$NEW_SHA" = "$HEAD_SHA" ]; then
        echo "ERROR: $app — CI build passed but the GHCR image is missing for $NEW_SHA" >&2
        return 3
      fi
      # Not a verdict yet: the caller checks the schema state before deciding
      # whether a deliberately skipped owner image is a failure (#695).
      return 2
    fi
    if [ "${CI_APP_BUILD[$app]-unknown}" = "success" ] && [ "$NEW_SHA" = "$HEAD_SHA" ]; then
      echo "ERROR: $app — CI build passed but the GHCR image is missing for $NEW_SHA" >&2
      return 3
    fi
    echo "$app: $image $(image_missing_cause) — skipping"
    return 0
  fi

  # Extract immutable digest from registry to pin deploy (#196).
  # docker manifest inspect returns JSON with the manifest digest — use it
  # to pull by digest instead of tag, closing the TOCTOU gap.
  image_digest=$(docker manifest inspect "$image" 2>/dev/null \
    | grep -o 'sha256:[a-f0-9]*' | head -1 || true)

  # Already-deployed guard: if any running container for this app already
  # carries the target digest, the deploy succeeded previously but the
  # state file was not written (e.g. post-switch monitor flapped). Skip
  # the full deploy cycle to avoid an infinite redeploy loop.
  if [ -n "$image_digest" ]; then
    local running_digest
    running_digest=$(docker inspect --format '{{.Image}}' \
      "$(docker ps --filter "name=^${app}-" --format '{{.Names}}' | head -1)" 2>/dev/null || true)
    if [ "$running_digest" = "$image_digest" ]; then
      echo "$app: already running target image ($image_digest) — skipping deploy"
      echo "$NEW_SHA" > "$state_file"
      record_schema_revision "$run_migrations" "$NEW_SHA"
      if [ -f "$fail_marker" ]; then
        echo "$app: previous deploy failure recovered ($(cat "$fail_marker"))"
        rm -f "$fail_marker"
        [ -f "$CI_GATE_STATE_DIR/$app.failed" ] || resolve_app_failed "$app"
      fi
      return 0
    fi
  fi

  if [ -z "$image_digest" ]; then
    echo "ERROR: $app — could not extract digest from manifest inspect" >&2
    # Fail closed: do not deploy without digest verification (#196)
    if [ ! -f "$fail_marker" ] || [ "$(cat "$fail_marker")" != "$NEW_SHA" ]; then
      echo "$NEW_SHA" > "$fail_marker"
      notify_app_failed "$app" "$NEW_SHA"
    fi
    return 1
  fi

  echo "=== Deploying $app @ $NEW_SHA (digest $image_digest) ==="
  mkdir -p "$target_dir/upstreams"
  cp "$REPO_DIR/.github/scripts/vps-deploy.sh" "$target_dir/"
  cp "$REPO_DIR/deploy/nginx/upstreams/${app}.conf" "$target_dir/upstreams/" 2>/dev/null || true

  migration_cmd=""
  if [ "$run_migrations" = "true" ]; then
    migration_cmd="node apps/messenger-bot/dist/infrastructure/database/vault-migrations.js run"
  fi

  if (
    cd "$target_dir"
    IMAGE="$image" IMAGE_DIGEST="$image_digest" DEPLOY_MODE=self-pull APP_NAME="$app" HEALTH_PATH="$health_path" \
    GHCR_PULL_TOKEN="$GHCR_PULL_TOKEN" GHCR_USER="$GHCR_USER" \
    RUN_MIGRATIONS="$run_migrations" MIGRATION_CMD="$migration_cmd" \
    MIGRATION_PREFLIGHT_CMD="node apps/messenger-bot/dist/infrastructure/database/vault-migrations.js preflight" \
    MIGRATION_STATUS_CMD="node apps/messenger-bot/dist/infrastructure/database/vault-migrations.js show" \
    MIGRATION_LOCK_ID="$MIGRATION_LOCK_ID" \
    NGINX_UPSTREAM_DIR="$NGINX_UPSTREAM_DIR" \
    APP_NETWORK="$APP_NETWORK" \
    bash vps-deploy.sh
  ); then
    echo "$NEW_SHA" > "$state_file"
    record_schema_revision "$run_migrations" "$NEW_SHA"
    if [ -f "$fail_marker" ]; then
      echo "$app: previous deploy failure recovered ($(cat "$fail_marker"))"
      rm -f "$fail_marker"
      [ -f "$CI_GATE_STATE_DIR/$app.failed" ] || resolve_app_failed "$app"
    fi
    return 0
  else
    echo "ERROR: deploy failed for $app @ $NEW_SHA — will retry next run" >&2
    # Alert once per (app, sha): the same failed sha retries every tick and
    # must not re-page each time (#202). The marker is cleared on success.
    if [ ! -f "$fail_marker" ] || [ "$(cat "$fail_marker")" != "$NEW_SHA" ]; then
      echo "$NEW_SHA" > "$fail_marker"
      notify_app_failed "$app" "$NEW_SHA"
    fi
    return 1
  fi
}

ci_evaluate_all
case "$CI_GLOBAL_STATE" in
  pending)
    ci_wait_for_retry "$CI_GLOBAL_REASON" || exit 1
    exit 0
    ;;
  failed)
    ci_fail_global "$CI_GLOBAL_REASON" || exit 1
    ;;
esac

if ! echo "$GHCR_PULL_TOKEN" | docker login "$REGISTRY" -u "$GHCR_USER" --password-stdin >/dev/null 2>&1; then
  echo "WARN [$(date -Is)] docker login to $REGISTRY failed — refusing to deploy until the GHCR pull token is fixed (#604)" >&2
  ci_fail_global "docker login to $REGISTRY failed; GHCR image state is unverifiable" || exit 1
fi

# Pinning the deploy to HEAD wedges the rollout whenever a commit produces no
# image. Docs, specs and CI-only commits legitimately build nothing, and the
# owner's "not published" path fails closed — 7285bd67 (a .github/scripts-only
# commit) blocked this barrier 1751 times, about 58 hours, on its own sha.
# Resolve the newest commit at or behind HEAD that the owner actually has an
# image for. If that commit is already deployed, deploy_app no-ops on the
# state file instead of paging. When nothing in the window has an image the
# target stays at HEAD and the fail-closed path still fires (#338).
resolve_target_sha() {
  local owner="${APP_ORDER[0]}" sha
  for sha in $(git rev-list -n "$RESOLVE_DEPTH" HEAD 2>/dev/null); do
    if docker manifest inspect "${REGISTRY}/${REPO_LC}/${owner}:${sha}" >/dev/null 2>&1; then
      printf %s "$sha"
      return 0
    fi
  done
  return 1
}

OWNER_APP="${APP_ORDER[0]}"
if [ "${CI_APP_BUILD[$OWNER_APP]-unknown}" = "success" ] && \
  ! docker manifest inspect "${REGISTRY}/${REPO_LC}/${OWNER_APP}:${HEAD_SHA}" >/dev/null 2>&1; then
  ci_fail_global "$OWNER_APP build-image passed but its GHCR image is missing for $HEAD_SHA" || exit 1
fi

RESOLVED_SHA=$(resolve_target_sha || true)
if [ -n "$RESOLVED_SHA" ] && [ "$RESOLVED_SHA" != "$NEW_SHA" ]; then
  echo "No image for HEAD ($NEW_SHA) — targeting newest published commit $RESOLVED_SHA"
  NEW_SHA="$RESOLVED_SHA"
fi

# Messenger owns the shared schema migration. Keep it first and make the
# schema state it leaves behind the barrier for Discord and Zalo (#283).
#
# Exit 2 means "owner has no image at this sha" — a question, not a verdict.
# The barrier's real condition is whether the schema is at the revision this
# release expects, so ask that before failing closed (#695): when the applied
# revision is an ancestor of the target and no migration was added between
# them, the dependent bots are safe to proceed. When a migration *was* added
# and no image exists to apply it, that is a genuine failure — fail closed and
# page, as #338 requires.
BARRIER_RC=0
ci_clear_app_failure "${APP_ORDER[0]}"
deploy_app "${APP_ORDER[0]}" true || BARRIER_RC=$?

if [ "$BARRIER_RC" = 2 ]; then
  OWNER_IMAGE="${REGISTRY}/${REPO_LC}/${APP_ORDER[0]}:${NEW_SHA}"
  if schema_current_for "$NEW_SHA"; then
    echo "${APP_ORDER[0]}: $OWNER_IMAGE $(image_missing_cause), but no migration changed since $(schema_revision) — schema is current, barrier ready"
    BARRIER_RC=0
  else
    echo "ERROR: ${APP_ORDER[0]} (migration owner) — $OWNER_IMAGE $(image_missing_cause); schema is not current for $NEW_SHA — barrier blocked" >&2
    OWNER_FAIL_MARKER="$STATE_DIR/${APP_ORDER[0]}.failed"
    if [ ! -f "$OWNER_FAIL_MARKER" ] || [ "$(cat "$OWNER_FAIL_MARKER")" != "$NEW_SHA" ]; then
      echo "$NEW_SHA" > "$OWNER_FAIL_MARKER"
      notify_app_failed "${APP_ORDER[0]}" "$NEW_SHA" "schema is not current for the target release"
    fi
    BARRIER_RC=1
  fi
elif [ "$BARRIER_RC" = 3 ]; then
  OWNER_FAIL_MARKER="$STATE_DIR/${APP_ORDER[0]}.failed"
  if [ ! -f "$OWNER_FAIL_MARKER" ] || [ "$(cat "$OWNER_FAIL_MARKER")" != "$NEW_SHA" ]; then
    echo "$NEW_SHA" > "$OWNER_FAIL_MARKER"
    notify_app_failed "${APP_ORDER[0]}" "$NEW_SHA" "CI reported a build but the GHCR image was missing"
  fi
  BARRIER_RC=1
fi

PENDING_APPS=()
DEPLOY_FAILURE=0
if [ "$BARRIER_RC" = 0 ]; then
  echo "Migration barrier ready — deploying dependent bots"
  for app in "${APP_ORDER[@]:1}"; do
    case "${CI_APP_STATE[$app]-failed}" in
      pending)
        PENDING_APPS+=("$app")
        ;;
      failed)
        ci_mark_app_failure "$app" "${CI_APP_REASON[$app]}"
        DEPLOY_FAILURE=1
        ;;
      pass)
        ci_clear_app_failure "$app"
        app_rc=0
        deploy_app "$app" || app_rc=$?
        case "$app_rc" in
          0) ;;
          3)
            ci_mark_app_failure "$app" "CI reported a build but the GHCR image was missing"
            DEPLOY_FAILURE=1
            ;;
          *) DEPLOY_FAILURE=1 ;;
        esac
        ;;
      *)
        ci_mark_app_failure "$app" "CI state was unavailable"
        DEPLOY_FAILURE=1
        ;;
    esac
  done
else
  echo "ERROR: migration barrier not ready — skipping Discord/Zalo deploys" >&2
  DEPLOY_FAILURE=1
fi

if [ "${#PENDING_APPS[@]}" -gt 0 ]; then
  PENDING_REASON="app CI gate pending: ${PENDING_APPS[*]}"
  ci_wait_for_retry "$PENDING_REASON" || exit 1
  exit 0
fi

if [ "$DEPLOY_FAILURE" -ne 0 ]; then
  exit 0
fi

ci_clear_current_state
recover_previous_stall
