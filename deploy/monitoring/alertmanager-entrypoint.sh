#!/bin/sh
set -e

# Render the Alertmanager config from the template.
# A small awk renderer substitutes only the allow-listed ${VAR} placeholders.
# Values come from ENVIRON and are YAML-escaped, so quotes/backslashes do not
# corrupt the rendered config. The runtime image has no envsubst/gettext, but
# busybox awk is present.
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

case "$TELEGRAM_CHAT_ID" in
  ''|*[!0-9-]*|0|-1|0[0-9]*|-0|-0[0-9]*)
    echo "FATAL: TELEGRAM_CHAT_ID must be a valid non-zero integer" >&2
    exit 1
    ;;
  -*)
    case "${TELEGRAM_CHAT_ID#-}" in
      ''|*[!0-9]*|0[0-9]*)
        echo "FATAL: TELEGRAM_CHAT_ID must be a valid non-zero integer" >&2
        exit 1
        ;;
    esac
    ;;
  *)
    case "$TELEGRAM_CHAT_ID" in
      *[!0-9]*|0[0-9]*)
        echo "FATAL: TELEGRAM_CHAT_ID must be a valid non-zero integer" >&2
        exit 1
        ;;
    esac
    ;;
esac

# --- Check awk availability ---
if ! command -v awk >/dev/null 2>&1; then
  echo "FATAL: awk not found — cannot render config" >&2
  exit 1
fi

if ! awk '
BEGIN {
  value = ENVIRON["TELEGRAM_CHAT_ID"]
  negative = substr(value, 1, 1) == "-"
  magnitude = negative ? substr(value, 2) : value
  limit = negative ? "9223372036854775808" : "9223372036854775807"
  if (length(magnitude) > length(limit) ||
      (length(magnitude) == length(limit) && ("x" magnitude) > ("x" limit))) exit 1
}' /dev/null; then
  echo "FATAL: TELEGRAM_CHAT_ID must fit in a signed 64-bit integer" >&2
  exit 1
fi

# --- Render config ---
SRC="${SRC:-/etc/alertmanager/alertmanager.tmpl}"
DST="${DST:-/etc/alertmanager/alertmanager.yml}"
if ! awk '
BEGIN {
  n = split("TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID", names, " ")
  for (i = 1; i <= n; i++) {
    if (ENVIRON[names[i]] ~ /[[:cntrl:]]/) exit 1
  }
}' /dev/null; then
  echo "FATAL: credential contains control characters" >&2
  exit 1
fi
if ! awk '
function allowed(name) {
  return name == "TELEGRAM_BOT_TOKEN" || name == "TELEGRAM_CHAT_ID"
}
{
  rest = $0
  if ($0 ~ /__[^[:space:]]+__/) exit 1
  while (match(rest, /\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*/)) {
    token = substr(rest, RSTART, RLENGTH)
    if (substr(token, 2, 1) != "{") exit 1
    name = substr(token, 3, length(token) - 3)
    if (!allowed(name)) exit 1
    rest = substr(rest, RSTART + RLENGTH)
  }
  if (index(rest, "${") > 0) exit 1
}' "$SRC"; then
  echo "FATAL: unresolved Alertmanager template placeholder" >&2
  exit 1
fi
awk '
function allowed(name) {
  return name == "TELEGRAM_BOT_TOKEN" || name == "TELEGRAM_CHAT_ID"
}
function yaml_escape(value, result, i, ch) {
  result = ""
  for (i = 1; i <= length(value); i++) {
    ch = substr(value, i, 1)
    if (ch == "\\") result = result "\\\\"
    else if (ch == "\"") result = result "\\\""
    else result = result ch
  }
  return result
}
{
  out = ""
  rest = $0
  while (match(rest, /\$\{[A-Za-z_][A-Za-z0-9_]*\}/)) {
    token = substr(rest, RSTART, RLENGTH)
    name = substr(token, 3, length(token) - 3)
    out = out substr(rest, 1, RSTART - 1)
    if (allowed(name)) out = out yaml_escape(ENVIRON[name])
    else out = out token
    rest = substr(rest, RSTART + RLENGTH)
  }
  print out rest
}' < "$SRC" > "$DST"

if ! awk '
function strip_field(line, field, start, value_start, i, escaped, ch) {
  start = index(line, field)
  if (start == 0) return line
  value_start = start + length(field)
  escaped = 0
  for (i = value_start; i <= length(line); i++) {
    ch = substr(line, i, 1)
    if (escaped) escaped = 0
    else if (ch == "\\") escaped = 1
    else if (ch == "\"")
      return substr(line, 1, start - 1) field "\"" substr(line, i + 1)
  }
  return line
}
{
  line = strip_field($0, "bot_token: \"")
  if (line ~ /__[^[:space:]]+__/ ||
      line ~ /\$\{[^}]*\}/ ||
      line ~ /\$[A-Za-z_][A-Za-z0-9_]*/ ||
      index(line, "${") > 0) exit 1
}' "$DST"; then
  echo "FATAL: unresolved Alertmanager template placeholder" >&2
  exit 1
fi

if [ "${DRY_RUN:-}" = "1" ]; then
  exit 0
fi

exec /bin/alertmanager \
  --config.file=/etc/alertmanager/alertmanager.yml \
  --storage.path=/alertmanager \
  --log.level=info
