# Doppler — Secret Management (prod + dev)

Production env on VPS is **synced from Doppler** by the manual `sync-env.yml` workflow. Bot containers do not mount the host Docker socket or host `.env`; this prevents an application compromise from becoming a host compromise. Local dev can use `doppler run` instead of copying `.env` manually.

Related: [project-overview.md](../../../docs/project-overview.md) § deploy, `.github/workflows/deploy-bots.yml`, `.env.example` (variable names only, no values).

---

## 0. Variables Shared Across Bots — Doppler Secret Reference

`messenger-bot`, `discord-bot`, and `zalo-bot` share some variables (`WISPACE_INTERNAL_KEY`, `OPENAI_*`, `DB_*`, `STUDY_REMINDER_TIMEZONE`/`SYNC_HORIZON_HOURS`/`MIN_LEAD_MINUTES`, `LLM_USAGE_*`, `LLM_COST_USD_PER_1M_*`, `CHAT_USAGE_TIMEZONE` — full list + sample values in [`.env.shared.example`](../../../.env.shared.example) at repo root). Local dev reads this file via `envFilePath: ['.env', '../../.env.shared']` (each app's `.env` overrides if same key). Production does **not** have a `.env.shared` file in the container (Doppler flattens everything into one `.env` file on deploy), so deduplication must be handled at the Doppler layer:

1. Create a new **`wispace-shared`** project on Doppler (configs `prd` + `dev`), entering variables from `.env.shared.example` with real values.
2. In each bot's own project (`messenger-bot`, `discord-bot`, ...), for each shared variable, **delete the manually typed value** and replace with a secret reference:
   ```
   ${{wispace-shared.prd.WISPACE_INTERNAL_KEY}}
   ```
   (change `prd` → `dev` for dev config). Doppler inlines the real value at `doppler secrets download` time.
3. Edit once in `wispace-shared`, all referencing bots update automatically — no need to edit each project.

Each bot deployment receives its own Doppler service-token input: `DOPPLER_TOKEN_MESSENGER`, `DOPPLER_TOKEN_DISCORD`, or `DOPPLER_TOKEN_ZALO`. The application containers do not contact Doppler at runtime.

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
# → upload .env to dev config (PORT=3001) + prd (PORT=5007, runtime sync disabled)

# Only one config:
node scripts/upload-env-to-doppler.mjs .env prd
```

After editing secrets on Doppler: run `npm run env:sync-prod` / re-run **Sync production env** workflow.

4. Dev config: copy from `prd` then adjust `PORT=3001`, local URLs, disable ops if needed.

---

## 2. GitHub Actions — Service Token

1. Doppler → Project **messenger-bot** → Config **prd** → **Access** → **Service Tokens** → Generate (read-only).
2. GitHub repo → **Settings** → **Secrets and variables** → **Actions** → New secret:
   - Name: the matching per-bot secret (`DOPPLER_TOKEN_MESSENGER`, `DOPPLER_TOKEN_DISCORD`, or `DOPPLER_TOKEN_ZALO`)
   - Value: newly created token (scoped to `prd` config only)

Every `main` deploy (or workflow_dispatch):

```text
docker build → push ghcr.io/... → VPS deploy (Doppler env when the matching `DOPPLER_TOKEN_*` is present)
```

Normal CI publishes the commit image to GHCR and the VPS self-pull job deploys it; SSH/SCP is retained for the manual env-sync path (no more `POST /v1/messenger/ops/ci-deploy` endpoint).

Prod env changed on Doppler: run **Sync production env (no image build)**.

**Required GitHub Secrets for SSH Deploy:**

| Secret                                                                     | Purpose                                                                |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `SSH_PRIVATE_KEY`                                                          | Private key matching `~/.ssh/authorized_keys` on VPS (`ngoc_anh`)      |
| `VPS_HOST`                                                                 | VPS IP (e.g. `69.62.74.196`)                                           |
| `VPS_USER`                                                                 | `ngoc_anh`                                                             |
| `DOPPLER_TOKEN_MESSENGER` / `DOPPLER_TOKEN_DISCORD` / `DOPPLER_TOKEN_ZALO` | (recommended) Downloads that bot's `production.env` during deploy/sync |
| `GHCR_PULL_TOKEN`                                                          | (recommended) `docker pull` on VPS                                     |

**Repository variable (optional):** `VPS_SSH_PORT` — default `22` in workflow (`vars.VPS_SSH_PORT || '22'`). The provider dropped inbound SSH on port `8443`, so CI now uses port 22.

**Open port 22 for GitHub (Hostinger hPanel):** VPS → **Security** → **Firewall** → rule **TCP 22** **Accept** from **Anywhere** (or whitelist Actions IPs from `https://api.github.com/meta` → `actions[]`). This is the port CI's env-only SSH path uses.

If `SSH_PRIVATE_KEY` / `VPS_*` **not yet** set, SCP/SSH step fails — add secret then re-run workflow.

If the matching `DOPPLER_TOKEN_*` is **not yet** set, workflow still publishes/deploys the image; that bot's env on VPS stays unchanged.

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

## 4. Change Prod Secret — Manual Sync

1. Edit on Doppler config **`prd`** (dashboard or CLI).
2. Run `npm run env:sync-prod` or Actions → **Sync production env (no image build)**.
3. The workflow writes the env file through the existing SSH deploy path and performs a controlled blue-green container replacement without exposing the Docker socket to the bot.

The workflow runs `chmod 600 production.env` immediately after downloading it. On the VPS, `vps-deploy.sh` re-applies `chmod 600` before reading either `production.env` or an existing `.env`, writes the downloaded values plus `DEPLOY_UID`/`DEPLOY_GID` to a mode-600 temporary file in the app directory, and atomically replaces `/home/ngoc_anh/<app>/.env`. An EXIT trap removes the temporary file and `production.env`; no `/home/ngoc_anh/.env` is created. `INTERNAL_API_KEY` must be present because the blue-green deploy verifies the protected `/metrics` endpoint before switching traffic.

### CI Deploy Code (`deploy-bots.yml` → `deploy-bot-reusable.yml`)

| Git Change                               | CI Action                                 |
| ---------------------------------------- | ----------------------------------------- |
| `src/`, `Dockerfile`, `package*.json`    | lint + test + **build image** + deploy    |
| Only `docker-compose`, workflow, scripts | **Skip build** — VPS uses `:latest` image |
| Only `docs/`                             | **Don't run** workflow                    |

Docker build still uses **GHA layer cache** (`cache-from/to: type=gha`).

The legacy `/v1/*/ops/doppler-sync` endpoints remain for compatibility but are disabled in production containers.

---

## 5. Rotate Secret (e.g. Meta App Secret)

1. Change value on Doppler dashboard (config `prd`).
2. Run **Sync production env (no image build)**.

No need to SSH-edit `.env` manually.
Secret rotation is manual: update Doppler and rerun the sync. Deploy scripts never generate or rotate secret values automatically. If a production or local env file was exposed, rotate every credential it contained before syncing again; see the recovery procedure in `docs/project-overview.md`.

---

## 6. Checklist

- [x] Project + configs `dev` / `prd` on Doppler (`messenger-bot`)
- [x] Secrets `prd` from VPS; `dev` from local (PORT=3001)
- [ ] GitHub secrets `DOPPLER_TOKEN_MESSENGER`, `DOPPLER_TOKEN_DISCORD`, `DOPPLER_TOKEN_ZALO` (service tokens for `prd` config)
- [ ] Deploy succeeds; CI log shows `Applied .env from Doppler` and `Deployment complete — container messenger-bot is healthy`
- [x] Repo: `.doppler.yaml` + `doppler setup` (dev)

- [x] Production env sync uses `sync-env.yml`; bot containers have no Docker socket access

---

## 7. Security

- **Don't** commit `.env`, don't paste secrets in PR/chat.
- Service token is **read-only**, scoped to **one config** (`prd`).
- CI applies `chmod 600 production.env` immediately after the Doppler download.
- VPS app env files are mode `600`; `vps-deploy.sh` uses a same-directory mode-600 temporary file and atomic replacement, then cleans up `production.env` with an EXIT trap.
- If an env file was exposed, rotate its credentials manually in Doppler/provider systems before the next sync; the scripts do not auto-rotate secrets.
