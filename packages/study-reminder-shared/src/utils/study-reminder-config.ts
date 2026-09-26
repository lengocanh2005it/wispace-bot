/**
 * Framework-free env readers for the study-reminder schedule settings.
 * The configured `StudyReminderScheduleService` stays an outer adapter;
 * application code that only needs a raw value reads it here instead of
 * importing that service (or wrapping a pure function in a port, #1088).
 */

export const DEFAULT_STUDY_REMINDER_SYNC_HORIZON_HOURS = 48;

function readPositiveNumber(raw: string | undefined, defaultValue: number) {
  const trimmed = raw?.trim();
  if (!trimmed) return defaultValue;
  const value = Number(trimmed);
  return Number.isFinite(value) && value > 0 ? value : defaultValue;
}

export function readSyncHorizonHours(
  get: (key: string) => string | undefined,
): number {
  return readPositiveNumber(
    get('STUDY_REMINDER_SYNC_HORIZON_HOURS'),
    DEFAULT_STUDY_REMINDER_SYNC_HORIZON_HOURS,
  );
}
