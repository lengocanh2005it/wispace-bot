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
STALL_ALERT="vps_self_pull_stall"
APP_FAIL_ALERT="vps_self_pull_app_failed"
STALL_MARKER="$STATE_DIR/stall"
# How far back to look for a commit that actually produced images.
RESOLVE_DEPTH="${RESOLVE_DEPTH:-20}"
# Revision whose migrations the owner has applied, and the tree the barrier
# compares against to decide whether the schema is already current (#695).
SCHEMA_STATE_FILE="$STATE_DIR/schema.sha"
MIGRATIONS_PATH="${MIGRATIONS_PATH:-packages/database/src/migrations}"

: "${GHCR_USER:?GHCR_USER is required}"
: "${GHCR_PULL_TOKEN:?GHCR_PULL_TOKEN is required}"

mkdir -p "$STATE_DIR"

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

notify_app_failed() { # app sha
  local app="$1" sha="$2"
  post_alert "$APP_FAIL_ALERT" "{\"summary\":\"$app deploy failed\",\"description\":\"$app @ $sha failed at $(date -Is); next cron tick retries.\"}" \
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

if [ -f "$STALL_MARKER" ]; then
  echo "Recovered from previous stall ($(cat "$STALL_MARKER"))"
  rm -f "$STALL_MARKER"
  resolve_stall
fi

NEW_SHA=$(current_sha)

# A failed login makes every later `manifest inspect` fail exactly like a
# missing image, and the operator was told "not published" — pointing them at
# CI when the fault is an expired pull token (#604). Keep `|| true` so a
# transient blip never kills the run, but record which cause to report (#695).
LOGIN_OK=true
if ! echo "$GHCR_PULL_TOKEN" | docker login "$REGISTRY" -u "$GHCR_USER" --password-stdin >/dev/null 2>&1; then
  LOGIN_OK=false
  echo "WARN [$(date -Is)] docker login to $REGISTRY failed — image checks below may be reporting a credential problem, not a missing build (#604)" >&2
fi

# Why an image could not be verified, for logs and alert text.
image_missing_cause() {
  if [ "$LOGIN_OK" = "true" ]; then
    printf 'not published yet (CI built no image for this sha)'
  else
    printf 'unverifiable — docker login to %s failed, check the GHCR pull token (#604)' "$REGISTRY"
  fi
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
      # Not a verdict yet: the caller checks the schema state before deciding
      # whether a missing owner image is a failure at all (#695).
      return 2
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
        resolve_app_failed "$app"
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
      resolve_app_failed "$app"
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
      notify_app_failed "${APP_ORDER[0]}" "$NEW_SHA"
    fi
    BARRIER_RC=1
  fi
fi

if [ "$BARRIER_RC" = 0 ]; then
  echo "Migration barrier ready — deploying dependent bots"
  for app in "${APP_ORDER[@]:1}"; do
    deploy_app "$app" || true
  done
else
  echo "ERROR: migration barrier not ready — skipping Discord/Zalo deploys" >&2
fi
