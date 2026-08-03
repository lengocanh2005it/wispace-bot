#!/bin/sh
set -e

# Render the Telegram receiver from the template — Alertmanager has no
# built-in env substitution, so placeholders are replaced here before start.
# A placeholder token keeps the config loadable until a real token is set.
TOKEN="${TELEGRAM_BOT_TOKEN:-}"
if [ -z "$TOKEN" ]; then
  TOKEN="0000000000:AA-PLACEHOLDER-PENDING-SETUP"
  echo "WARNING: TELEGRAM_BOT_TOKEN is not set — alerts will not be delivered"
fi
# chat_id 0 is the Go zero value and fails Alertmanager validation, so the
# fallback is -1 until a real chat id is configured.
CHAT="${TELEGRAM_CHAT_ID:--1}"

sed -e "s|__TELEGRAM_BOT_TOKEN__|${TOKEN}|g" \
    -e "s|__TELEGRAM_CHAT_ID__|${CHAT}|g" \
    /etc/alertmanager/alertmanager.tmpl > /etc/alertmanager/alertmanager.yml

exec /bin/alertmanager \
  --config.file=/etc/alertmanager/alertmanager.yml \
  --storage.path=/alertmanager \
  --log.level=info
