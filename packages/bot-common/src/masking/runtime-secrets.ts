/**
 * Runtime secret VALUES known to the process (#632): registered at boot by
 * each app from config. The registry lives in bot-common so the bootstrap can
 * populate it without depending on the LLM package.
 */
let runtimeSecretValues: string[] = [];

/** Min length keeps generic values ("true", "1", provider names) unharmed. */
const MIN_RUNTIME_SECRET_LENGTH = 8;

/**
 * Fixed list of config keys whose values are secrets in every bot app.
 * Callers pass their config getter; empty and short values are dropped.
 * When a new secret env var is added, add its key here too.
 */
const RUNTIME_SECRET_ENV_KEYS = [
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'MINIMAX_API_KEY',
  'OPENAI_COMPATIBLE_API_KEY',
  'INTERNAL_API_KEY',
  'WISPACE_INTERNAL_KEY',
  'DB_PASSWORD',
  'REDIS_PASSWORD',
  'MESSENGER_PAGE_TOKEN',
  'MESSENGER_APP_SECRET',
  'VERIFY_TOKEN',
  'DISCORD_BOT_TOKEN',
  'ZALO_APP_SECRET',
  'ZALO_TOKEN_ENCRYPTION_KEY',
  'OAUTH_STATE_ENCRYPTION_KEY',
  'DISCORD_OAUTH_STATE_ENCRYPTION_KEY',
  'ZALO_OAUTH_STATE_ENCRYPTION_KEY',
] as const;

export function registerRuntimeSecrets(values: string[]): void {
  runtimeSecretValues = [
    ...new Set(
      (values ?? [])
        .map((value) => (value ?? '').trim())
        .filter((value) => value.length >= MIN_RUNTIME_SECRET_LENGTH),
    ),
  ];
}

export function resetRuntimeSecretsForTests(): void {
  runtimeSecretValues = [];
}

export function getRegisteredRuntimeSecretValues(): string[] {
  return [...runtimeSecretValues];
}

export function collectRuntimeSecretValues(
  get: (key: string) => string | undefined,
): string[] {
  return RUNTIME_SECRET_ENV_KEYS.map((key) => get(key) ?? '').filter(
    (value) => value.length >= MIN_RUNTIME_SECRET_LENGTH,
  );
}
