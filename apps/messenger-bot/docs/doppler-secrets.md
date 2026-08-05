# Doppler — Secret Management (prod + dev)

Production env on VPS is **synced from Doppler** on every GitHub Actions deploy (when `DOPPLER_TOKEN` is present). Local dev can use `doppler run` instead of copying `.env` manually.

Related: [project-overview.md](../../docs/project-overview.md) § deploy, `.github/workflows/deploy-messenger-bot.yml`, `.env.example` (variable names only, no values).

---

## 0. Variables Shared Across Bots — Doppler Secret Reference

`messenger-bot` + `discord-bot` (and `zalo-bot` later) share some variables (`WISPACE_INTERNAL_KEY`, `OPENAI_*`, `DB_*`, `STUDY_REMINDER_TIMEZONE`/`SYNC_HORIZON_HOURS`/`MIN_LEAD_MINUTES`, `LLM_USAGE_*`, `LLM_COST_USD_PER_1M_*`, `CHAT_USAGE_TIMEZONE` — full list + sample values in [`.env.shared.example`](../../../.env.shared.example) at repo root). Local dev reads this file via `envFilePath: ['.env', '../../.env.shared']` (each app's `.env` overrides if same key). Production does **not** have a `.env.shared` file in the container (Doppler flattens everything into one `.env` file on deploy), so deduplication must be handled at the Doppler layer:

1. Create a new **`wispace-shared`** project on Doppler (configs `prd` + `dev`), entering variables from `.env.shared.example` with real values.
2. In each bot's own project (`messenger-bot`, `discord-bot`, ...), for each shared variable, **delete the manually typed value** and replace with a secret reference:
   ```
   ${{wispace-shared.prd.WISPACE_INTERNAL_KEY}}
   ```
   (change `prd` → `dev` for dev config). Doppler inlines the real value at `doppler secrets download` time.
3. Edit once in `wispace-shared`, all referencing bots update automatically — no need to edit each project.

`discord-bot` currently **doesn't have** its own Doppler project (only uses manual `.env`) — when setting up, follow section 1 below with `project: discord-bot`, then apply step 2 above for shared variables.

---

## 1. Create Project on Doppler (One-Time)

1. Sign up at [Doppler](https://dashboard.doppler.com/) → **Create Project** (e.g. `messenger-bot`).
2. Create **configs**:
   - `dev` — dev machine / ngrok
   - `prd` — VPS production (`PORT=5007`, `CHAT_RATE_LIMIT_ENABLED=true`, …)
3. Import variables from current VPS `.env`:

```bash
# On machine with prod file (not committed)
doppler login
doppler setup --project messenger-bot --config prd
doppler secrets upload /path/to/production.env
```

Or paste individual keys on the dashboard. **Don't** commit the prod file to git.

**Upload from local `.env` (sync to Doppler):**

```bash
doppler login
npm run env:upload-doppler
# → upload .env to dev config (PORT=3001) + prd (PORT=5007, DOPPLER_RUNTIME_SYNC_ENABLED=true)

# Only one config:
node scripts/upload-env-to-doppler.mjs .env prd
```

After editing secrets on Doppler: webhook auto-syncs VPS, or `npm run env:sync-prod` / Re-run **Sync production env** workflow.

4. Dev config: copy from `prd` then adjust `PORT=3001`, local URLs, disable ops if needed.

---

## 2. GitHub Actions — Service Token

1. Doppler → Project **messenger-bot** → Config **prd** → **Access** → **Service Tokens** → Generate (read-only).
2. GitHub repo → **Settings** → **Secrets and variables** → **Actions** → New secret:
   - Name: `DOPPLER_TOKEN`
   - Value: newly created token (scoped to `prd` config only)

Every `main` deploy (or workflow_dispatch):

```text
docker build → push ghcr.io/... → SCP + SSH to VPS (Doppler env when DOPPLER_TOKEN present)
```

Current CI deploy uses SSH/SCP only (no more `POST /messenger/ops/ci-deploy` endpoint).

Prod env changed on Doppler: webhook → `POST /messenger/ops/doppler-sync` (no GitHub needed).

**Required GitHub Secrets for SSH Deploy:**

| Secret | Purpose |
|--------|---------|
| `SSH_PRIVATE_KEY` | Private key matching `~/.ssh/authorized_keys` on VPS (`ngoc_anh`) |
| `VPS_HOST` | VPS IP (e.g. `69.62.74.196`) |
| `VPS_USER` | `ngoc_anh` |
| `DOPPLER_TOKEN` | (recommended) Downloads `production.env` each deploy |
| `GHCR_PULL_TOKEN` | (recommended) `docker pull` on VPS |

**Repository variable (optional):** `VPS_SSH_PORT` — default `8443` in workflow. Port **22** on OS (UFW) is open; GitHub Actions runners usually **timeout** connecting to `:22` due to Hostinger hPanel firewall blocking cloud IPs. `sshd` listens on **8443** as well (allowed on UFW) — CI uses this port.

**Open port 22 for GitHub (Hostinger hPanel):** VPS → **Security** → **Firewall** → rule **TCP 22** **Accept** from **Anywhere** (or whitelist Actions IPs from `https://api.github.com/meta` → `actions[]`). Then you can set `VPS_SSH_PORT=22`.

If `SSH_PRIVATE_KEY` / `VPS_*` **not yet** set, SCP/SSH step fails — add secret then re-run workflow.

If `DOPPLER_TOKEN` **not yet** set, workflow still deploys image; env on VPS stays unchanged (or use doppler-sync webhook when secrets change).

---

## 3. Local Dev with Doppler

```bash
# Install CLI: https://docs.doppler.com/docs/install-cli
doppler login
doppler setup --project messenger-bot --config dev

# Run app (no .env file on disk needed)
npm run start:dev:doppler

# Other scripts
doppler run -- npm run study-reminder:jobs
```

Still possible to use `.env` + `npm run start:dev` if Doppler isn't installed.

---

## 4. Change Prod Secret — Full-Auto (VPS Webhook)

1. Edit on Doppler config **`prd`** (dashboard or CLI).
2. Doppler webhook → `POST https://aiassist.aihubproduction.com/messenger/ops/doppler-sync` (auto sync + restart).

Runtime sync writes temp `/tmp/.env.sync.tmp` then `copyFile` to `/deploy/.env` (host `.env` bind mount), **merges back** `DEPLOY_*` / `DOCKER_GID` (Doppler doesn't contain deploy keys). Recreates via sidecar `docker:29-cli` mounting host deploy dir (avoids `cwd` host path not existing in container).

**No GitHub Actions needed** when only changing env.

**Manual (no webhook):** `npm run env:sync-prod` or Actions → **Sync production env (no image build)**.

### CI Deploy Code (`deploy-bots.yml` → `deploy-bot-reusable.yml`)

| Git Change | CI Action |
|------------|-----------|
| `src/`, `Dockerfile`, `package*.json` | lint + test + **build image** + deploy |
| Only `docker-compose`, workflow, scripts | **Skip build** — VPS uses `:latest` image |
| Only `docs/` | **Don't run** workflow |

Docker build still uses **GHA layer cache** (`cache-from/to: type=gha`).

### Webhook Setup (One-Time)

1. Doppler → **messenger-bot** → **prd** → **Webhooks** → Add.
2. **URL:** `https://aiassist.aihubproduction.com/messenger/ops/doppler-sync`
3. **Custom header:** `x-internal-api-key: <INTERNAL_API_KEY>` (value from `prd` config).
4. On Doppler `prd`, add secret:
   - `DOPPLER_RUNTIME_TOKEN` = read-only service token for `prd` (same value as GitHub secret `DOPPLER_TOKEN`).

After image with this feature is deployed, test manually:

```bash
curl -sS -X POST https://aiassist.aihubproduction.com/messenger/ops/doppler-sync \
  -H "x-internal-api-key: YOUR_INTERNAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"project":"messenger-bot","config":"prd"}'
# → HTTP 202 {"accepted":true}
```

---

## 5. Rotate Secret (e.g. Meta App Secret)

1. Change value on Doppler dashboard (config `prd`) — webhook auto-syncs VPS.
2. Or push `main` / Re-run Deploy — CI still writes `.env` when deploying code.

No need to SSH-edit `.env` manually.

---

## 6. Checklist

- [x] Project + configs `dev` / `prd` on Doppler (`messenger-bot`)
- [x] Secrets `prd` from VPS; `dev` from local (PORT=3001)
- [x] GitHub secret `DOPPLER_TOKEN` (service token for `prd` config)
- [ ] Deploy succeeds; CI log shows `Applied .env from Doppler` and `Deployment complete — container messenger-bot is healthy`
- [x] Repo: `.doppler.yaml` + `doppler setup` (dev)

- [ ] Doppler webhook → `POST /messenger/ops/doppler-sync` + `DOPPLER_RUNTIME_TOKEN` on `prd`

---

## 7. Security

- **Don't** commit `.env`, don't paste secrets in PR/chat.
- Service token is **read-only**, scoped to **one config** (`prd`).
- Files on VPS: `chmod 600` (CI uses `install -m 600`).
