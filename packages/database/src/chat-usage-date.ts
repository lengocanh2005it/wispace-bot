import { LEGACY_TIMEZONE_ENV_KEYS, resolveTimezone } from '@wispace/contracts';

/**
 * Current chat usage date in the configured reporting timezone (ADR-0027).
 *
 * Lives outside `migrations/` on purpose: TypeORM globs that directory and
 * treats every export it finds as a migration class, so a helper exported
 * from a migration file fails discovery with "migration name is wrong"
 * and takes the whole migration chain down with it.
 */
export function currentChatUsageDate(
  now = new Date(),
  timezone = resolveTimezone(
    (key) => process.env[key],
    LEGACY_TIMEZONE_ENV_KEYS.chatUsage,
  ),
): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}
