#!/bin/sh
set -e

# Render the scrape credentials from the template — Prometheus has no
# built-in env substitution, so placeholders are replaced here before start.
# NOTE: keys containing '|' or '&' would break the sed delimiters.
sed -e "s|__INTERNAL_API_KEY_MESSENGER__|${INTERNAL_API_KEY_MESSENGER}|g" \
    -e "s|__INTERNAL_API_KEY_DISCORD__|${INTERNAL_API_KEY_DISCORD}|g" \
    -e "s|__INTERNAL_API_KEY_ZALO__|${INTERNAL_API_KEY_ZALO}|g" \
    /etc/prometheus/prometheus.tmpl > /etc/prometheus/prometheus.yml

exec /bin/prometheus "$@"
