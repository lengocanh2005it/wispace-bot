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
- Body: 256k for webhook, 1m for other paths (matches `HTTP_JSON_BODY_LIMIT` in the app)
