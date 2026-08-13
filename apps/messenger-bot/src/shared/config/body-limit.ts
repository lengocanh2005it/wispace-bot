const DEFAULT_BODY_LIMIT_BYTES = 256 * 1024;
const MAX_BODY_LIMIT_BYTES = 1024 * 1024;

export function parseJsonBodyLimit(raw: string | undefined): number {
  const value = raw?.trim() || '256kb';
  const match = /^(\d+)\s*(b|kb|mb)?$/i.exec(value);
  if (!match) {
    throw new Error(
      `HTTP_JSON_BODY_LIMIT must be a positive byte value up to 1mb (received ${value})`,
    );
  }

  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase() ?? 'b';
  const multiplier = unit === 'mb' ? 1024 * 1024 : unit === 'kb' ? 1024 : 1;
  const bytes = amount * multiplier;

  if (
    !Number.isSafeInteger(bytes) ||
    bytes <= 0 ||
    bytes > MAX_BODY_LIMIT_BYTES
  ) {
    throw new Error(
      `HTTP_JSON_BODY_LIMIT must be a positive byte value up to 1mb (received ${value})`,
    );
  }

  return bytes || DEFAULT_BODY_LIMIT_BYTES;
}
