#!/bin/sh
set -e

# Render the Alertmanager config from the template.
# A small awk renderer substitutes only the allow-listed ${VAR} placeholders
# byte-verbatim: values come from ENVIRON (no escape processing), so secrets
# with $, quotes, backslashes or unicode render exactly. The runtime image
# has no envsubst/gettext, but busybox awk is present.
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

# --- Check awk availability ---
if ! command -v awk >/dev/null 2>&1; then
  echo "FATAL: awk not found — cannot render config" >&2
  exit 1
fi

# --- Render config ---
SRC="${SRC:-/etc/alertmanager/alertmanager.tmpl}"
DST="${DST:-/etc/alertmanager/alertmanager.yml}"
awk '
{
  line = $0
  n = split("TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID", names, " ")
  for (i = 1; i <= n; i++) {
    key = names[i]
    ph = "${" key "}"
    val = ENVIRON[key]
    out = ""
    rest = line
    while ((p = index(rest, ph)) > 0) {
      out = out substr(rest, 1, p - 1) val
      rest = substr(rest, p + length(ph))
    }
    line = out rest
  }
  print line
}' < "$SRC" > "$DST"

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
