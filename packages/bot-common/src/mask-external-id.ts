/**
 * Mask an external user identifier (PSID, Discord ID, Zalo OA user ID) for
 * safe logging.  Shows first 4 + last 4 characters with `…` in between so
 * ops can still correlate across logs without exposing the full ID.
 *
 * Returns `'???'` for falsy input.
 */
export function maskExternalId(id?: string | null): string {
  if (!id) return '???';
  if (id.length <= 10) return id.slice(0, 2) + '…';
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}
