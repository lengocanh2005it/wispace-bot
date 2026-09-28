/**
 * The single credential-redaction primitive for the whole repo.
 *
 * Two independent jobs, in this deliberate order:
 *  1. **Registered runtime secret values** (`#632`) — exact-value replacement.
 *     A secret that does not look like a secret is invisible to any pattern.
 *  2. **Credential shapes** — catch anything unregistered.
 *
 * Both the model-context boundary (`@wispace/llm-agent`) and the log/telemetry
 * boundaries (`errorMessage`, `redactSafetyText`) go through here, so a new
 * shape is added once and every direction inherits it. Keeping the registry
 * read here rather than in each consumer is what stops a shape-only copy from
 * silently diverging into a weaker implementation.
 */
import { getRegisteredRuntimeSecretValues } from './runtime-secrets';

/** One placeholder convention across logs, model context and telemetry. */
export const REDACTED_PLACEHOLDER = '[REDACTED]';

/**
 * Credential-shape matchers. Shared by the input-side redaction below and by
 * the output-side final-output guard, so both directions stay symmetric.
 */
/**
 * OpenAI-style provider keys, named because the log sink applies it on its own:
 * its other patterns are all *broader* than the canonical ones for their case
 * (any URI scheme, any secret-ish key in a `key=value`, any bearer), so they
 * already cover the corresponding canonical shapes while keeping the context a
 * log line needs. A `sk-` key matches nothing else, so it is the one shape that
 * has to be named here rather than reached for through the array.
 */
export const PROVIDER_KEY_SHAPE = /\bsk-[A-Za-z0-9]{16,}\b/i;

export const CREDENTIAL_SHAPES: RegExp[] = [
  // OpenAI-style keys.
  PROVIDER_KEY_SHAPE,
  // Bearer tokens.
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}\b/i,
  // Explicit secret assignments (api_key/password/secret = value).
  /\b(?:api[_-]?key|password|passwd|secret)\s*[:=]\s*\S{8,}\b/i,
  // JWTs — three base64url segments; the signature segment is long enough
  // that ordinary prose never matches.
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{1,}\.[A-Za-z0-9_-]{10,}\b/,
  // Connection strings with embedded credentials (user may be empty:
  // redis://:password@host).
  /\b(?:postgres(?:ql)?|redis|mongodb(?:\+srv)?):\/\/[^\s/@]*:[^\s/@]+@[^\s]+/i,
];

/** First matching shape, or null — used by both scanners. */
export function findCredentialShape(text: string): RegExpMatchArray | null {
  for (const pattern of CREDENTIAL_SHAPES) {
    const match = text.match(pattern);
    if (match) {
      return match;
    }
  }
  return null;
}

/**
 * Replace registered runtime secret values with the shared placeholder.
 *
 * Exact-value replacement, so it is idempotent and never damages text that a
 * richer, context-preserving pattern list (see `errorMessage`) already
 * redacted. Log sinks use this on their own; model context and safety
 * telemetry additionally use {@link redactCredentialText}.
 */
/** Replace every occurrence of one shape; promotes a non-global pattern. */
export function redactCredentialShape(text: string, pattern: RegExp): string {
  if (!pattern.test(text)) {
    return text;
  }
  return text.replace(
    new RegExp(
      pattern.source,
      pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
    ),
    REDACTED_PLACEHOLDER,
  );
}

export function redactRegisteredSecretValues(text: string): {
  text: string;
  redacted: boolean;
} {
  let output = text;
  let redacted = false;

  for (const value of getRegisteredRuntimeSecretValues()) {
    if (output.includes(value)) {
      output = output.split(value).join(REDACTED_PLACEHOLDER);
      redacted = true;
    }
  }

  return { text: output, redacted };
}

/**
 * Replace registered runtime secret values, then any credential-shaped text,
 * with the shared placeholder. Non-global patterns are promoted to global for
 * the replace so every occurrence in the string is covered.
 */
export function redactCredentialText(text: string): {
  text: string;
  redacted: boolean;
} {
  const registryPass = redactRegisteredSecretValues(text);
  let output = registryPass.text;
  let redacted = registryPass.redacted;

  for (const pattern of CREDENTIAL_SHAPES) {
    const next = redactCredentialShape(output, pattern);
    if (next !== output) {
      output = next;
      redacted = true;
    }
  }

  return { text: output, redacted };
}
