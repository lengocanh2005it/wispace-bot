#!/bin/sh
set -e

# Render the Alertmanager config from the template.
# envsubst handles arbitrary secret characters safely (no delimiter corruption).
# Fail closed: missing credentials → exit 1 → container restart loop.
# Test hooks (defaults are the container paths): SRC/DST override the
# template/output locations, DRY_RUN=1 stops after render + guard (no exec).

# --- Validate credentials ---
if [ -z "${TELEGRAM_BOT_TOKEN:-}" ]; then
  echo "FATAL: TELEGRAM_BOT_TOKEN is not set — cannot start Alertmanager" >&2
  exit 1
fi

if [ -z "${TELEGRAM_CHAT_ID:-}" ]; then
  echo "FATAL: TELEGRAM_CHAT_ID is not set — cannot start Alertmanager" >&2
  exit 1
fi

# --- Check envsubst availability ---
if ! command -v envsubst >/dev/null 2>&1; then
  echo "FATAL: envsubst not found — install gettext package" >&2
  exit 1
fi

# --- Render config ---
SRC="${SRC:-/etc/alertmanager/alertmanager.tmpl}"
DST="${DST:-/etc/alertmanager/alertmanager.yml}"
envsubst '$TELEGRAM_BOT_TOKEN $TELEGRAM_CHAT_ID' \
  < "$SRC" \
  > "$DST"

if grep -Eq '__[A-Z0-9_]+__|\$\{?(TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID)\}?' \
  "$DST"; then
  echo "FATAL: unresolved Alertmanager credential placeholder" >&2
  exit 1
fi

if [ "${DRY_RUN:-}" = "1" ]; then
  exit 0
fi

exec /bin/alertmanager \
  --config.file=/etc/alertmanager/alertmanager.yml \
  --storage.path=/alertmanager \
  --log.level=info
