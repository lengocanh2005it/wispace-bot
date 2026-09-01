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

## Preflight and tests

Before a production deploy, verify that each AppRole can read the shared path
and its own path, and inspect only path/key metadata—not values—in the operator
terminal or CI logs. The loader contract is covered by table-driven tests for
canonical paths, merge/collision behavior, malformed responses, timeouts,
redaction, limits, atomic injection, and restart rotation. Each bot also has a
bootstrap-adapter smoke test.

Production delivery is migrated separately by issue #654; this document defines
the runtime contract used by that deployment work.
