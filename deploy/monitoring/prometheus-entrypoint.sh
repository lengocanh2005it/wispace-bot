#!/bin/sh
set -e

# Render the Prometheus config from the template.
# A small awk renderer substitutes only the allow-listed ${VAR} placeholders.
# Values come from ENVIRON and are YAML-escaped, so quotes/backslashes do not
# corrupt the rendered config. The runtime image has no envsubst/gettext, but
# busybox awk is present.
# Fail closed: missing credentials → exit 1 → container restart loop.
# Test hooks (defaults are the container paths): SRC/DST override the
# template/output locations, DRY_RUN=1 stops after render + guard (no exec).

# --- Validate credentials ---
if [ -z "${INTERNAL_API_KEY_MESSENGER:-}" ]; then
  echo "FATAL: INTERNAL_API_KEY_MESSENGER is not set — cannot start Prometheus" >&2
  exit 1
fi

if [ -z "${INTERNAL_API_KEY_DISCORD:-}" ]; then
  echo "FATAL: INTERNAL_API_KEY_DISCORD is not set — cannot start Prometheus" >&2
  exit 1
fi

if [ -z "${INTERNAL_API_KEY_ZALO:-}" ]; then
  echo "FATAL: INTERNAL_API_KEY_ZALO is not set — cannot start Prometheus" >&2
  exit 1
fi

# --- Check awk availability ---
if ! command -v awk >/dev/null 2>&1; then
  echo "FATAL: awk not found — cannot render config" >&2
  exit 1
fi

# --- Render config ---
SRC="${SRC:-/etc/prometheus/prometheus.tmpl}"
DST="${DST:-/etc/prometheus/prometheus.yml}"
if ! awk '
BEGIN {
  n = split("INTERNAL_API_KEY_MESSENGER INTERNAL_API_KEY_DISCORD INTERNAL_API_KEY_ZALO", names, " ")
  for (i = 1; i <= n; i++) {
    if (ENVIRON[names[i]] ~ /[[:cntrl:]]/) exit 1
  }
}' /dev/null; then
  echo "FATAL: credential contains control characters" >&2
  exit 1
fi
if ! awk '
function allowed(name) {
  return name == "INTERNAL_API_KEY_MESSENGER" ||
    name == "INTERNAL_API_KEY_DISCORD" ||
    name == "INTERNAL_API_KEY_ZALO"
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
  echo "FATAL: unresolved Prometheus template placeholder" >&2
  exit 1
fi
awk '
function allowed(name) {
  return name == "INTERNAL_API_KEY_MESSENGER" ||
    name == "INTERNAL_API_KEY_DISCORD" ||
    name == "INTERNAL_API_KEY_ZALO"
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
  line = strip_field($0, "credentials: \"")
  if (line ~ /__[^[:space:]]+__/ ||
      line ~ /\$\{[^}]*\}/ ||
      line ~ /\$[A-Za-z_][A-Za-z0-9_]*/ ||
      index(line, "${") > 0) exit 1
}' "$DST"; then
  echo "FATAL: unresolved Prometheus template placeholder" >&2
  exit 1
fi

if [ "${DRY_RUN:-}" = "1" ]; then
  exit 0
fi

exec /bin/prometheus "$@"
