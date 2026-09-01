# Doppler — Legacy local development reference

> Production delivery is Vault-only. Do not use Doppler, service tokens, or
> full environment files for production. Follow the
> [Vault deployment runbook](../../../docs/vault-secrets.md). The remaining
> Doppler support is retained only for local development until issue #655.

## Local development

```bash
# Install the CLI: https://docs.doppler.com/docs/install-cli
doppler login
doppler setup --project messenger-bot --config dev

# Run without creating a local .env file
npm run start:dev:doppler

# Other local scripts
doppler run -- npm run study-reminder:jobs
```

The regular `.env` flow remains supported when the Doppler CLI is unavailable:

```bash
cp .env.shared.example .env.shared
cd apps/messenger-bot
cp .env.example .env
npm run start:dev
```

Shared local variables live in [`.env.shared.example`](../../../.env.shared.example);
platform-specific variables live in each app's `.env.example`. Never commit
either file after filling in real values.

## Production pointer

The production workflows accept only Vault endpoint/AppRole bootstrap material,
install it atomically with mode `600`, and fetch runtime secrets inside each
bot. Manual sync, self-pull, fresh install, rollback, rotation, and recovery
are documented in [the Vault runbook](../../../docs/vault-secrets.md).
