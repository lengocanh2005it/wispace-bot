/**
 * Boot-time fail-closed config check for the key every ops endpoint is guarded
 * with (`InternalApiKeyGuard`).
 *
 * The guard itself already rejects every request when the key is absent, so the
 * failure mode without this check is a process that boots healthy, passes
 * `/health/ready`, and then 500s on all ops routes — the worst shape for a
 * deploy gate, because the health probe passes.
 *
 * `bootstrapBot` calls this after `loadVaultSecrets` and before
 * `NestFactory.create`, so a missing key aborts startup — and a Vault-delivered
 * key counts as present, which is why the check cannot live in a
 * `ConfigModule.forRoot({ validate })` hook (that runs at import time, before
 * Vault has run). This replaces a per-app DI provider whose `getOrThrow` never
 * fired: nothing injected its token, so the check it existed to perform did not
 * run.
 */
const INTERNAL_API_KEY_ENV = 'INTERNAL_API_KEY';

/** Matches the registry's floor: a shorter key is not a usable credential. */
const MIN_INTERNAL_API_KEY_LENGTH = 8;

export function validateInternalApiKeyEnv(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const raw = config[INTERNAL_API_KEY_ENV];
  const value = raw == null ? '' : String(raw).trim();

  if (!value) {
    throw new Error(
      `${INTERNAL_API_KEY_ENV} is required — every ops endpoint is guarded by it. Refusing to start.`,
    );
  }
  if (value.length < MIN_INTERNAL_API_KEY_LENGTH) {
    throw new Error(
      `${INTERNAL_API_KEY_ENV} must be at least ${MIN_INTERNAL_API_KEY_LENGTH} characters. Refusing to start.`,
    );
  }

  return config;
}
