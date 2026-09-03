# Nginx — messenger-bot production (VPS)

Domain: `https://aiassist.aihubproduction.com` → `127.0.0.1:5007` (Docker binds to localhost only).

## Install on VPS (one-time / when changing config)

```bash
cd /home/ngoc_anh/messenger-bot   # or clone the repo

sudo cp deploy/nginx/messenger-bot-rate-limit.conf /etc/nginx/conf.d/
sudo cp deploy/nginx/aiassist.aihubproduction.com.conf /etc/nginx/sites-available/aiassist.aihubproduction.com
sudo ln -sf /etc/nginx/sites-available/aiassist.aihubproduction.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

## Docker — do not expose port to the internet

`docker-compose.prod.yml`:

```yaml
ports:
  - '127.0.0.1:${PORT:-5007}:${PORT:-5007}'
```

Recreate the container after changes:

```bash
docker compose -f docker-compose.prod.yml up -d --force-recreate
```

The VPS blue-green deploy uses bare `docker run` instead of Compose. Each active bot joins the external Docker network `monitoring` with a stable `<app>-metrics` alias; Prometheus scrapes the fixed internal listener port while Nginx continues switching the localhost host ports. The deploy script creates `monitoring` when needed and rolls back if the protected `/metrics` check or alias handoff fails.

## Verify

```bash
curl -sf https://aiassist.aihubproduction.com/health/ready          # messenger
curl -sf https://aiassist.aihubproduction.com/health/discord/ready  # discord
curl -sf https://aiassist.aihubproduction.com/health/zalo/ready     # zalo
curl -sf --connect-timeout 3 http://127.0.0.1:5007/health/ready
# Public IP:5007 should fail / timeout
curl -sf --connect-timeout 3 http://$(curl -s ifconfig.me):5007/health/ready && echo UNEXPECTED || echo OK_blocked
```

## Rate limit

- Zones: Messenger webhook 20 req/s, Zalo webhook 20 req/s, readiness 5 req/s; all are exact-match locations
- Zone `sensitive` 10 req/s (burst 20, `nodelay`, per-IP) covers the Discord prefix, the Zalo prefix and the catch-all — i.e. every ops endpoint (`/v1/*/ops*`, send-reports, privacy, doppler-sync, llm-usage), both OAuth route pairs and the publicly proxied `/metrics`. OAuth entry/callback routes additionally carry the app-level `ThrottlerGuard` (#535)
- Body: 256k for webhook, 1m for other paths (matches `HTTP_JSON_BODY_LIMIT` in the app)

### Legitimate caller exception list (#535)

No IP allowlist is configured — legit callers rely on `INTERNAL_API_KEY` plus the rate limits above:

| Caller | Route | Auth path |
| --- | --- | --- |
| Prometheus | `/metrics` (internal Docker network `<app>-metrics` aliases, not routed via nginx) | internal key |
| Deploy script health gates | `/health/ready`, `/health/{discord,zalo}/ready` via `curl --resolve` | none (public readiness) |
| WISPACE backend | `POST /v1/messenger/wispace/web-activity` | internal key |
| WISPACE portal frontend | `GET /v1/discord/link-status` | internal key |
| Admin runbooks | ops POST endpoints (send-reports, privacy, sync, …) | internal key |

### Brute-force spot check (after changing nginx config)

`sensitive` = 10r/s with burst=20 nodelay → roughly the first ~21 rapid requests pass through before 429s start. 25 hits also crosses the app-level alert threshold (>20 rejections in 5m), so one loop covers both checks:

```bash
sudo nginx -t && sudo systemctl reload nginx
# 25 rapid unauthenticated hits to an ops route → expect 401 for the first ~21, then 429 at the tail
for i in $(seq 1 25); do curl -s -o /dev/null -w '%{http_code}\n' \
  https://aiassist.aihubproduction.com/v1/messenger/ops/llm-usage/fleet; done
# Then confirm Alertmanager delivered the InternalAuthRejectedSpike warning to Telegram (fires after ~2m)
```
