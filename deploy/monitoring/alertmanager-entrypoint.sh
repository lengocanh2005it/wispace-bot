#!/bin/sh
set -e

# Render the Alertmanager config from the template.
# envsubst handles arbitrary secret characters safely (no delimiter corruption).
# Fail closed: missing credentials → exit 1 → container restart loop.

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
envsubst '$TELEGRAM_BOT_TOKEN $TELEGRAM_CHAT_ID' \
  < /etc/alertmanager/alertmanager.tmpl \
  > /etc/alertmanager/alertmanager.yml

exec /bin/alertmanager \
  --config.file=/etc/alertmanager/alertmanager.yml \
  --storage.path=/alertmanager \
  --log.level=info
