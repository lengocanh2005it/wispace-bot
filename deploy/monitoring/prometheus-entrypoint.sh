#!/bin/sh
set -e

# Render the Prometheus config from the template.
# envsubst handles arbitrary secret characters safely (no delimiter corruption).
# Fail closed: missing credentials → exit 1 → container restart loop.
# Test hooks (defaults are the container paths): SRC/DST override the
# template/output locations, DRY_RUN=1 stops after render + guard (no exec).

# --- Validate credentials ---
for var in INTERNAL_API_KEY_MESSENGER INTERNAL_API_KEY_DISCORD INTERNAL_API_KEY_ZALO; do
  eval "val=\${$var:-}"
  if [ -z "$val" ]; then
    echo "FATAL: $var is not set — cannot start Prometheus" >&2
    exit 1
  fi
done

# --- Check envsubst availability ---
if ! command -v envsubst >/dev/null 2>&1; then
  echo "FATAL: envsubst not found — install gettext package" >&2
  exit 1
fi

# --- Render config ---
SRC="${SRC:-/etc/prometheus/prometheus.tmpl}"
DST="${DST:-/etc/prometheus/prometheus.yml}"
envsubst '$INTERNAL_API_KEY_MESSENGER $INTERNAL_API_KEY_DISCORD $INTERNAL_API_KEY_ZALO' \
  < "$SRC" \
  > "$DST"

if grep -Eq '__[A-Z0-9_]+__|\$\{?(INTERNAL_API_KEY_MESSENGER|INTERNAL_API_KEY_DISCORD|INTERNAL_API_KEY_ZALO)\}?' \
  "$DST"; then
  echo "FATAL: unresolved Prometheus credential placeholder" >&2
  exit 1
fi

if [ "${DRY_RUN:-}" = "1" ]; then
  exit 0
fi

exec /bin/prometheus "$@"
