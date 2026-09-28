import { createHash } from 'node:crypto';
import { redactCredentialText } from '@wispace/bot-common/masking';

/**
 * Safety-telemetry redaction policy (#122): never persist raw user input,
 * assistant output, tool data or error text. Each text becomes:
 *  - `hash`      — SHA-256 of the raw text (dedup/correlation, one-way)
 *  - `excerpt`   — control-chars stripped, credential-like patterns masked,
 *                  whitespace collapsed, truncated to `maxChars`
 *  - `length`    — original length for ops sizing
 *
 * Credential *shapes* and registered runtime secret values come from the
 * shared primitive in `@wispace/bot-common/masking` — one list for the whole
 * repo, so this module cannot drift into a weaker copy. What remains below is
 * the layer that is specific to telemetry: long opaque tokens, PEM blocks and
 * the PII this table must never store.
 */

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Telemetry-specific extras. Credential shapes are NOT listed here. */
const TELEMETRY_PATTERNS: RegExp[] = [
  // PEM private keys
  /-----BEGIN [A-Z0-9 ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]+ PRIVATE KEY-----/g,
  // 64-char hex (hashes / digests)
  /\b[0-9a-f]{64}\b/gi,
  // Long opaque alphanumeric tokens (>= 32 chars) with no credential shape
  /\b[A-Za-z0-9]{32,}\b/g,
  // Emails — PII this table must not store
  /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g,
  // Vietnamese phone numbers — PII this table must not store
  /\b(?:0|\+84)(?:3[2-9]|5[2689]|7[06789]|8[1-9]|9[0-9])\d{7}\b/g,
  // Key=value secrets, including the OAuth token names the shared shape omits
  /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|token)\b\s*[=:]\s*\S+/gi,
];

export interface RedactedSafetyText {
  hash: string;
  excerpt: string;
  originalLength: number;
}

export function redactSafetyText(
  raw: string,
  maxChars = 120,
): RedactedSafetyText {
  const clean = raw.replace(CONTROL_CHAR_RE, '').replace(/\s+/g, ' ').trim();
  let masked = redactCredentialText(clean).text;
  for (const pattern of TELEMETRY_PATTERNS) {
    masked = masked.replace(pattern, '[REDACTED]');
  }
  const excerpt =
    masked.length > maxChars
      ? `${masked.slice(0, maxChars).trimEnd()}...`
      : masked;

  return {
    hash: createHash('sha256').update(raw, 'utf8').digest('hex'),
    excerpt,
    originalLength: raw.length,
  };
}
