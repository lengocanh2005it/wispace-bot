import { CREDENTIAL_SHAPES } from './secret-patterns.utils';
import { getRegisteredRuntimeSecretValues } from '@wispace/bot-common/masking';

export {
  collectRuntimeSecretValues,
  registerRuntimeSecrets,
  resetRuntimeSecretsForTests,
} from '@wispace/bot-common/masking';

/**
 * Runtime secret VALUES known to the process (#632): registered at boot by
 * each app from config. Shape matching alone cannot catch a secret that
 * doesn't look like one — exact-value replacement can. Module-level by
 * design: the sanitizers stay signature-stable and every call site inherits
 * the registered values.
 */
/** Same placeholder as bot-common's errorMessage redaction — one convention. */
export const REDACTED_PLACEHOLDER = '[REDACTED]';

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

  for (const value of getRegisteredRuntimeSecretValues()) {
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
