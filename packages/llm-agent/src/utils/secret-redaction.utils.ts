import { CREDENTIAL_SHAPES } from './secret-patterns.utils';

/**
 * Runtime secret VALUES known to the process (#632): registered at boot by
 * each app from config. Shape matching alone cannot catch a secret that
 * doesn't look like one — exact-value replacement can. Module-level by
 * design: the sanitizers stay signature-stable and every call site inherits
 * the registered values.
 */
let runtimeSecretValues: string[] = [];

/** Min length keeps generic values ("true", "1", provider names) unharmed. */
const MIN_RUNTIME_SECRET_LENGTH = 8;
/** Same placeholder as bot-common's errorMessage redaction — one convention. */
export const REDACTED_PLACEHOLDER = '[REDACTED]';

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

/**
 * Fixed list of config keys whose values are secrets in every bot app.
 * Callers pass their config getter; empty and short values are dropped.
 * When you add a new secret env var to the repo, add its key here too —
 * the registry only redacts what it knows.
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

export function collectRuntimeSecretValues(
  get: (key: string) => string | undefined,
): string[] {
  return RUNTIME_SECRET_ENV_KEYS.map((key) => get(key) ?? '').filter(
    (value) => value.length >= MIN_RUNTIME_SECRET_LENGTH,
  );
}

export interface SecretRedactionResult {
  text: string;
  redacted: boolean;
}

/**
 * Input-side hygiene (#632): replace credential-shaped text and registered
 * runtime secret values before a string may reach model context. Order is
 * deliberate — runtime values first (exact match, can span shape patterns),
 * then shapes for anything unregistered.
 */
export function redactSecrets(text: string): SecretRedactionResult {
  let output = text;
  let redacted = false;

  for (const value of runtimeSecretValues) {
    if (output.includes(value)) {
      output = output.split(value).join(REDACTED_PLACEHOLDER);
      redacted = true;
    }
  }

  for (const pattern of CREDENTIAL_SHAPES) {
    if (pattern.test(output)) {
      output = output.replace(
        new RegExp(
          pattern.source,
          pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
        ),
        REDACTED_PLACEHOLDER,
      );
      redacted = true;
    }
  }

  return { text: output, redacted };
}
