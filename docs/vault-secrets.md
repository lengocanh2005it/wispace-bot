# Vault runtime secret contract

The three bot processes load HashiCorp Vault KV v2 secrets before creating the
Nest application. The shared loader lives in `@wispace/bot-common`; each app
only supplies its fixed application identity (`messenger`, `discord`, or
`zalo`).

## Paths

The `secret` KV v2 mount uses these API paths in production:

```text
secret/data/wispace-bots/shared/prd
secret/data/wispace-bots/messenger/prd
secret/data/wispace-bots/discord/prd
secret/data/wispace-bots/zalo/prd
```

The shared path is loaded first and the application path second. An
application value may override a shared value only when its key is explicitly
allowlisted in code; unexpected duplicate keys fail startup. There is no
legacy path fallback and `VAULT_SECRET_PATH` is unsupported.

## Bootstrap contract

Production must provide:

```env
NODE_ENV=production
VAULT_REQUIRED=true
VAULT_ADDR=https://vault.example.com
VAULT_ROLE_ID=...
VAULT_SECRET_ID=...
```

Production always uses the `prd` environment. Non-production processes may set
`VAULT_ENV=dev` (or another lowercase environment name) when Vault is used;
otherwise set `VAULT_REQUIRED=false` and use local `.env` files. A partial Vault
configuration is an error, not a silent fallback.

`VAULT_ADDR` must use HTTPS in production and must not contain URL credentials,
query parameters, or fragments. Use the host's normal CA trust store (or
configure a CA before starting Node); never disable TLS verification.

Each bot has its own AppRole. Its policy may read the shared path and that
bot's path only, with no list, write, or delete capability. The AppRole client
token is held only for the bootstrap requests, and `VAULT_ROLE_ID`/
`VAULT_SECRET_ID` are removed from the process environment after the attempt.

## Backup offsite credentials and key escrow (#866)

The shared Vault path also stores the backup secrets so they survive VPS loss:

- `BACKUP_ENCRYPTION_PASSPHRASE` — GPG passphrase for nightly backups,
  pre-migration dumps, and restore verification. Escrowed here because the
  VPS-local copy is destroyed with the VPS; this KV entry is the recovery
  copy (keep a second operator copy per the DR runbook). Rotation requires
  re-encrypting the retained window — align changes with the 14-day
  retention so old artifacts stay readable, or re-upload the window after
  rotating.
- `OFFSITE_S3_ENDPOINT` / `OFFSITE_S3_BUCKET` / `OFFSITE_S3_ACCESS_KEY` /
  `OFFSITE_S3_SECRET_KEY` / `OFFSITE_S3_REGION` (optional) — least-privilege
  object-store credentials used by `deploy/postgres-offsite-sync.sh`; the
  access key must allow put/list on the backup bucket only.

The deploy env-allowlist accepts `BACKUP_ENCRYPTION_PASSPHRASE` in the Vault
bootstrap; the offsite sync reads `OFFSITE_S3_*` from the same file and builds
a mode-600 temp rclone config (never argv, never logged).

## Loading and failure behavior

The loader authenticates once, fetches shared and per-bot data sequentially,
validates both responses, merges them in memory, and injects only after the
whole contract is valid. It uses a 5-second timeout per request and does not
retry inside the process. Any authentication error, unavailable Vault, 404,
malformed KV v2 envelope, non-string value, invalid key, duplicate key, or
size-limit violation fails startup before Nest initialization.

Responses are bounded to 1 MiB, 512 keys per path, and 256 KiB per value.
Values remain strings so multiline certificates and keys are preserved. Logs
contain only phases, statuses, and counts; response bodies, tokens,
AppRole material, and secret values are never logged.

Secret rotation is restart-based: write the new KV version, start a new
container, pass its health gate, then retire the old container. Reads use the
current KV version; restoring a previous KV version is an operator action
before a later restart.

## Production delivery (#654/#655)

Production deploys deliver only a short-lived `vault-bootstrap.env`; a full
secret-bearing runtime env file is not created, uploaded, or retained. The
reusable workflow requires the repository/environment variable `VAULT_ADDR` and
these per-bot GitHub Actions secrets:

```text
VAULT_ROLE_ID_MESSENGER / VAULT_SECRET_ID_MESSENGER
VAULT_ROLE_ID_DISCORD  / VAULT_SECRET_ID_DISCORD
VAULT_ROLE_ID_ZALO     / VAULT_SECRET_ID_ZALO
```

The workflow writes the bootstrap atomically with mode `600`, uploads it with
the release, and the VPS replaces the app's `.env` atomically after validating
the allowlist. The file contains only Vault bootstrap and deploy-owned flags;
the bot loads the actual runtime secrets from Vault inside the container.
Missing credentials, invalid bootstrap content, Vault startup failure, failed
migrations, health/readiness failure, or metrics/nginx verification failure
stops before cutover and leaves the healthy container serving traffic.

Use the manual **Sync production env** workflow to refresh AppRole bootstrap
credentials and force a recreate. Self-pull deploys reuse the existing
mode-600 bootstrap on the VPS; a missing or invalid file fails closed and
alerts the operator. A fresh install provisions the same bootstrap through the
SSH deploy workflow before starting any bot. For rotation, update the new
AppRole credentials in GitHub, deploy and verify all three bots, then revoke the
old AppRole credentials. Rollback changes nginx back to the previous healthy
container; it does not roll back Vault data.

The deployment regression suite covers fresh/manual/self-pull delivery,
rotation, rollback, migration fencing, and rejection of full-secret artifacts.

## Preflight and tests

Before a production deploy, verify that each AppRole can read the shared path
and its own path, and inspect only path/key metadata—not values—in the operator
terminal or CI logs. The loader contract is covered by table-driven tests for
canonical paths, merge/collision behavior, malformed responses, timeouts,
redaction, limits, atomic injection, and restart rotation. Each bot also has a
bootstrap-adapter smoke test.

Before a deploy, verify AppRole policy access to the shared and per-bot paths
without printing values. The runtime contract and this delivery flow are
Vault-only.
