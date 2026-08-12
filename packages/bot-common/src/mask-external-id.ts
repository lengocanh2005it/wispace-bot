/**
 * Mask an external user identifier (PSID, Discord ID, Zalo OA user ID,
 * WISPACE numeric user id) for safe logging. Shows first 4 + last 4
 * characters with `…` in between so ops can still correlate across logs
 * without exposing the full ID.
 *
 * Returns `'???'` for falsy input.
 */
export function maskExternalId(id?: string | number | null): string {
  const value = id === undefined || id === null ? '' : String(id);
  if (!value) return '???';
  if (value.length <= 10) return value.slice(0, 2) + '…';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/** Replace an external id in an error/log string without changing other text. */
export function maskExternalIdInText(
  text: string,
  externalUserId?: string | number | null,
): string {
  if (externalUserId === undefined || externalUserId === null) return text;
  const value = String(externalUserId);
  return value ? text.split(value).join(maskExternalId(value)) : text;
}

/**
 * Mask an external id that is embedded inside a composite key/event id
 * (e.g. the durable inbox event id `pb:<psid>:<payload>:<ts>` built for
 * events without a platform message id). The dedupe key itself is never
 * changed — only its log representation.
 *
 * Returns `eventId` unchanged when no known external id is embedded.
 */
export function maskEventId(
  eventId: string,
  externalUserId?: string | number | null,
): string {
  if (!externalUserId) {
    return eventId;
  }
  const id = String(externalUserId);
  if (!eventId.includes(id)) {
    return eventId;
  }
  return eventId.split(id).join(maskExternalId(id));
}
