import { Logger } from '@nestjs/common';

const log = new Logger('VaultSecrets');

/**
 * Fetch secrets from HashiCorp Vault and inject into process.env.
 * Call BEFORE NestFactory.create() so ConfigModule picks them up.
 *
 * Skipped when VAULT_ADDR is not set (local dev uses .env files).
 * Fail-fast: throws if VAULT_ADDR is set but Vault is unreachable.
 */
export async function loadVaultSecrets(): Promise<void> {
  const vaultAddr = process.env.VAULT_ADDR;
  if (!vaultAddr) {
    log.warn('VAULT_ADDR not set — skipping Vault, using .env files');
    return;
  }

  const roleId = process.env.VAULT_ROLE_ID;
  const secretId = process.env.VAULT_SECRET_ID;
  if (!roleId || !secretId) {
    throw new Error(
      'VAULT_ADDR is set but VAULT_ROLE_ID or VAULT_SECRET_ID is missing',
    );
  }

  const secretPath =
    process.env.VAULT_SECRET_PATH ?? 'secret/data/wispace-bots/discord/prd';

  log.log(`Authenticating with Vault at ${vaultAddr}...`);

  // AppRole login
  const loginRes = await fetch(`${vaultAddr}/v1/auth/approle/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role_id: roleId, secret_id: secretId }),
  });

  if (!loginRes.ok) {
    const body = await loginRes.text();
    throw new Error(`Vault AppRole login failed (${loginRes.status}): ${body}`);
  }

  const { auth } = (await loginRes.json()) as {
    auth: { client_token: string };
  };
  const token = auth.client_token;

  log.log('Authenticated. Fetching secrets...');

  // Fetch KV v2 secrets
  const secretsRes = await fetch(`${vaultAddr}/v1/${secretPath}`, {
    headers: { 'X-Vault-Token': token },
  });

  if (!secretsRes.ok) {
    const body = await secretsRes.text();
    throw new Error(
      `Vault secrets fetch failed (${secretsRes.status}): ${body}`,
    );
  }

  const { data } = (await secretsRes.json()) as {
    data: { data: Record<string, string> };
  };
  const secrets = data.data;

  // Inject into process.env — Vault is the primary source, overrides .env
  let injected = 0;
  for (const [key, value] of Object.entries(secrets)) {
    process.env[key] = value;
    injected++;
  }

  log.log(
    `Loaded ${Object.keys(secrets).length} secrets from Vault, injected ${injected} env vars`,
  );
}
