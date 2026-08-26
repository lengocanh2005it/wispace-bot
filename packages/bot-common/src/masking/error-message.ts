import { maskExternalIdInText } from './mask-external-id';

export interface ErrorMessageOptions {
  /** Maximum character length before truncation. Defaults to 500. */
  maxChars?: number;
  /** Known external user ID to mask (e.g. PSID, Discord ID, Zalo OA ID, WISPACE user ID). */
  externalUserId?: string | number | null;
}

const DEFAULT_MAX_ERROR_CHARS = 500;

/* eslint-disable no-control-regex -- intentional control-char stripping for log injection prevention */
const ALL_CONTROL_CHARS_PATTERN = /[\u0000-\u001F\u007F]/g;
const NON_NEWLINE_CONTROL_CHARS_PATTERN = /[\u0000-\u0009\u000B-\u001F\u007F]/g;
/* eslint-enable no-control-regex */

const MULTI_SPACE_PATTERN = /\s+/g;

const SENSITIVE_KV_PATTERN =
  /\b((?:bearer|token|pass(?:word|wd)?|secret|api[_-]?key|credential|private[_-]?key|access[_-]?token|refresh[_-]?token|auth(?:orization)?|internal[_-]?key)\s*[:=]\s*(?:Bearer\s+)?)(['"]?)[^\s,"'&]+(\2)/gi;

const BEARER_TOKEN_PATTERN = /\bBearer\s+(?!\[REDACTED\])[^\s,"']+/gi;

const QUERY_SECRET_PATTERN =
  /([?&](?:token|key|api_key|apiKey|secret|password|auth|access_token|refresh_token|credential)=)[^\s&"'#]+/gi;

const URI_CREDENTIALS_PATTERN =
  /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^:\s/@]*:[^@\s/]+@/g;

const JWT_PATTERN =
  /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_.-]+\b/g;

function redactSecrets(text: string): string {
  return text
    .replace(SENSITIVE_KV_PATTERN, '$1$2[REDACTED]$2')
    .replace(BEARER_TOKEN_PATTERN, 'Bearer [REDACTED]')
    .replace(QUERY_SECRET_PATTERN, '$1[REDACTED]')
    .replace(URI_CREDENTIALS_PATTERN, '$1[REDACTED]@')
    .replace(JWT_PATTERN, '[REDACTED]');
}

/**
 * Extract a sanitized, redacted string message from any caught error value.
 *
 * Rules:
 * - Strips control characters and collapses whitespace to prevent log injection.
 * - Redacts Bearer tokens, passwords, secrets, api keys, credentials, and URL query secrets.
 * - Redacts credentials in connection URIs (e.g. postgres:// or redis://).
 * - Redacts JWT tokens.
 * - Masks known external user IDs if provided.
 * - Limits total length to `maxChars` (defaults to 500).
 */
export function errorMessage(
  err: unknown,
  optionsOrExternalUserId?: ErrorMessageOptions | string | number | null,
): string {
  let raw: string;
  if (err instanceof Error) {
    raw = err.message || err.name || 'Error';
  } else if (typeof err === 'string') {
    raw = err;
  } else if (err === null || err === undefined) {
    raw = 'Unknown error';
  } else if (typeof err === 'object') {
    const maybeMessage = (err as Record<string, unknown>).message;
    if (typeof maybeMessage === 'string' && maybeMessage.trim()) {
      raw = maybeMessage;
    } else {
      raw = String(err);
      if (raw === '[object Object]') {
        raw = 'Unknown error';
      }
    }
  } else {
    raw = String(err);
  }

  let options: ErrorMessageOptions;
  if (
    optionsOrExternalUserId &&
    typeof optionsOrExternalUserId === 'object' &&
    typeof (optionsOrExternalUserId as ErrorMessageOptions).maxChars ===
      'number'
  ) {
    options = optionsOrExternalUserId;
  } else if (
    optionsOrExternalUserId &&
    typeof optionsOrExternalUserId === 'object' &&
    'externalUserId' in optionsOrExternalUserId
  ) {
    options = optionsOrExternalUserId;
  } else {
    options = {
      externalUserId: optionsOrExternalUserId as
        | string
        | number
        | null
        | undefined,
    };
  }

  const maxChars = options.maxChars ?? DEFAULT_MAX_ERROR_CHARS;

  let message = redactSecrets(raw);

  // Strip all control characters (including newlines and tabs) to prevent log injection
  message = message.replace(ALL_CONTROL_CHARS_PATTERN, ' ');
  message = message.replace(MULTI_SPACE_PATTERN, ' ').trim();

  if (!message) {
    return 'Unknown error';
  }

  if (options.externalUserId !== undefined && options.externalUserId !== null) {
    message = maskExternalIdInText(message, options.externalUserId);
  }

  if (message.length > maxChars) {
    return message.slice(0, maxChars);
  }

  return message;
}

/**
 * Sanitize an error stack trace by redacting secrets and stripping control characters.
 * Preserves newlines so stack frames remain readable across lines.
 */
export function sanitizeErrorStack(
  stack?: string,
  maxChars = 2000,
): string | undefined {
  if (!stack || typeof stack !== 'string') {
    return undefined;
  }

  let sanitized = redactSecrets(stack);
  sanitized = sanitized.replace(NON_NEWLINE_CONTROL_CHARS_PATTERN, '');

  if (sanitized.length > maxChars) {
    return sanitized.slice(0, maxChars) + '…';
  }

  return sanitized;
}
