import { createHash } from 'crypto';

/**
 * SHA-256 hex digest of an external user identifier, for pseudonymized
 * persistence in non-key columns (e.g. `chat_quota_events.aggregate_id`,
 * #640/#541). Deterministic, so equality queries keep working: hash the
 * raw id with this same function before filtering.
 *
 * Returns `''` for falsy input so callers never persist a hash of `null`.
 */
export function hashExternalId(id?: string | null): string {
  if (!id) return '';
  return createHash('sha256').update(id, 'utf8').digest('hex');
}

/**
 * Cap for error text persisted in DB columns (`last_error`, `error_message`)
 * — data minimization at write time (#640). Overridable via
 * `PERSISTED_ERROR_MAX_CHARS`; default 2000 covers any realistic provider
 * message while bounding storage and leak surface.
 */
const DEFAULT_PERSISTED_ERROR_MAX_CHARS = 2000;

/**
 * Truncate an already-redacted error string before persisting it in a DB
 * column. Deliberately separate from `errorMessage()` (which sanitizes raw
 * errors for logs): persistence callers sanitize first, then bound length
 * here so the cap is enforced uniformly at the write site even when the
 * upstream message came pre-formatted.
 */
export function truncatePersistedError(
  text: string | null | undefined,
  maxChars?: number,
): string | null {
  if (!text) return null;
  const cap =
    maxChars ??
    readPersistedErrorMaxChars(process.env.PERSISTED_ERROR_MAX_CHARS);
  return text.length > cap ? text.slice(0, cap) : text;
}

function readPersistedErrorMaxChars(raw?: string): number {
  if (!raw?.trim()) return DEFAULT_PERSISTED_ERROR_MAX_CHARS;
  const value = Number(raw.trim());
  return Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_PERSISTED_ERROR_MAX_CHARS;
}
