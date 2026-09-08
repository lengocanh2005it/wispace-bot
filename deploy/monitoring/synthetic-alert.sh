#!/usr/bin/env bash
set -euo pipefail

# Synthetic alert probe (#683): exercises the full alert path in-band —
# fire an alert into the local Alertmanager, wait for evaluation/delivery,
# resolve it, then self-check that the alert left the pending queue.
#
# Cadence (install both crons — see the install block below):
#   Daily 09:07 ICT  → severity=warning  (exercises discord-warning only)
#   Monday 09:02 ICT → severity=critical (exercises all three critical legs)
#
# The script posts with endsAt so the alert auto-expires in Alertmanager even
# if the resolve step fails — a crashed probe must not leave a firing alert.
# Delivery failure is also detected out-of-band by the AlertDeliveryFailed
# rule (alertmanager_notifications_failed_total).
#
# Install (adjust the home path to the actual deploy user):
#   mkdir -p ~/logs && cp deploy/monitoring/synthetic-alert.sh ~/scripts/
#   chmod +x ~/scripts/synthetic-alert.sh
#   crontab -e:  (cron runs UTC; 02:07/02:02 UTC = 09:07/09:02 ICT)
#     7 2 * * *  SYNTHETIC_SEVERITY=warning  $HOME/scripts/synthetic-alert.sh >> $HOME/logs/synthetic-alert.log 2>&1
#     2 2 * * 1  SYNTHETIC_SEVERITY=critical $HOME/scripts/synthetic-alert.sh >> $HOME/logs/synthetic-alert.log 2>&1

ALERTMANAGER_URL="${ALERTMANAGER_URL:-http://127.0.0.1:9093}"
SEVERITY="${SYNTHETIC_SEVERITY:-warning}"
ALERTNAME="SyntheticRoutingCheck"
WAIT_SECONDS="${SYNTHETIC_WAIT_SECONDS:-75}"

if [ "$SEVERITY" != "warning" ] && [ "$SEVERITY" != "critical" ]; then
  echo "SYNTHETIC_SEVERITY must be warning or critical (got: $SEVERITY)" >&2
  exit 2
fi

ends_at() { date -u -d "+${1} seconds" +%Y-%m-%dT%H:%M:%S.000Z; }

post_alert() { # status firing|resolved
  local status="$1"
  local ends offset
  if [ "$status" = "resolved" ]; then offset=-1; else offset=300; fi
  ends="$(ends_at "$offset")"
  curl -sf -X POST "$ALERTMANAGER_URL/api/v2/alerts" \
    -H 'Content-Type: application/json' \
    -d "[{\"labels\":{\"alertname\":\"$ALERTNAME\",\"severity\":\"$SEVERITY\",\"job\":\"synthetic\",\"probe\":\"routing\"},\"annotations\":{\"summary\":\"Synthetic $SEVERITY routing check\",\"description\":\"Scheduled end-to-end alert-path probe (#683). Safe to ignore.\"},\"startsAt\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",\"endsAt\":\"$ends\"}]" \
    >/dev/null
}

# List of alert instances currently pending/firing in Alertmanager.
# Fails closed: an API query error aborts the probe (never report OK on a
# broken check) — same contract as backup-monitor.sh.
alerts_pending() {
  local response
  if ! response=$(curl -sf "$ALERTMANAGER_URL/api/v2/alerts?active=true&silenced=false&inhibited=false"); then
    echo "ERROR: cannot query $ALERTMANAGER_URL/api/v2/alerts" >&2
    return 1
  fi
  printf '%s' "$response" | grep -c "\"alertname\":\"$ALERTNAME\"" || true
}

echo "[synthetic] firing $ALERTNAME severity=$SEVERITY at $(date -Is)"
if ! post_alert firing; then
  echo "ERROR: could not POST alert to $ALERTMANAGER_URL" >&2
  exit 1
fi

# Wait for AM to evaluate and fan out (group_wait 30s + provider latency).
sleep "$WAIT_SECONDS"

PENDING=$(alerts_pending)
if [ "$PENDING" -eq 0 ]; then
  echo "ERROR: synthetic alert vanished before resolve — check Alertmanager logs" >&2
  exit 1
fi

if ! post_alert resolved; then
  echo "ERROR: resolve POST failed; alert auto-expires via endsAt" >&2
  exit 1
fi

sleep 5
REMAINING=$(alerts_pending)
if [ "$REMAINING" -ne 0 ]; then
  echo "ERROR: synthetic alert did not resolve cleanly" >&2
  exit 1
fi

echo "[synthetic] OK: $ALERTNAME ($SEVERITY) fired and resolved through the full path"
