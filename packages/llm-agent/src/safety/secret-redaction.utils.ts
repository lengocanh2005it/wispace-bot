import { redactCredentialText } from '@wispace/bot-common/masking';

export {
  collectRuntimeSecretValues,
  registerRuntimeSecrets,
  resetRuntimeSecretsForTests,
} from '@wispace/bot-common/masking';

/** Same placeholder as bot-common's errorMessage redaction — one convention. */
export { REDACTED_PLACEHOLDER } from '@wispace/bot-common/masking';

export interface SecretRedactionResult {
  text: string;
  redacted: boolean;
}

/**
 * Input-side hygiene (#632): replace credential-shaped text and registered
 * runtime secret values before a string may reach model context. The registry
 * and the shapes live in `@wispace/bot-common/masking` so the log and telemetry
 * sinks share the exact same primitive — order (runtime values first, then
 * shapes) is defined there.
 */
export function redactSecrets(text: string): SecretRedactionResult {
  return redactCredentialText(text);
}
