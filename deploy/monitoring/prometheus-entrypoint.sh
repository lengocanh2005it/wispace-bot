#!/bin/sh
set -e

# Render the Prometheus config from the template.
# envsubst handles arbitrary secret characters safely (no delimiter corruption).
# Fail closed: missing credentials → exit 1 → container restart loop.

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
envsubst '$INTERNAL_API_KEY_MESSENGER $INTERNAL_API_KEY_DISCORD $INTERNAL_API_KEY_ZALO' \
  < /etc/prometheus/prometheus.tmpl \
  > /etc/prometheus/prometheus.yml

exec /bin/prometheus "$@"
