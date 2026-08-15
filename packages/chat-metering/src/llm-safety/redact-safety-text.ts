import { createHash } from 'node:crypto';

/**
 * Safety-telemetry redaction policy (#122): never persist raw user input,
 * assistant output, tool data or error text. Each text becomes:
 *  - `hash`      — SHA-256 of the raw text (dedup/correlation, one-way)
 *  - `excerpt`   — control-chars stripped, credential-like patterns masked,
 *                  whitespace collapsed, truncated to `maxChars`
 *  - `length`    — original length for ops sizing
 */

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

const CREDENTIAL_PATTERNS: RegExp[] = [
  // JWT (header.payload.signature)
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // Bearer tokens
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi,
  // PEM private keys
  /-----BEGIN [A-Z0-9 ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]+ PRIVATE KEY-----/g,
  // 64-char hex (API keys / hashes)
  /\b[0-9a-f]{64}\b/gi,
  // Long alphanumeric tokens (>= 32 chars)
  /\b[A-Za-z0-9]{32,}\b/g,
  // Emails
  /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g,
  // Vietnamese phone numbers
  /\b(?:0|\+84)(?:3[2-9]|5[2689]|7[06789]|8[1-9]|9[0-9])\d{7}\b/g,
  // Key=value secrets
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
  let masked = clean;
  for (const pattern of CREDENTIAL_PATTERNS) {
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
