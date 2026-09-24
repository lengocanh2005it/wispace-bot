import {
  getDatePartsInTimezone,
  todayInTimezone,
  tomorrowInTimezone,
} from '@wispace/date-utils';

/** ICT calendar date for scheduled report idempotency (R4). */
export function todayReportDate(
  timezone = 'Asia/Ho_Chi_Minh',
  now = new Date(),
): string {
  return todayInTimezone(timezone, now);
}

/**
 * Absolute instant at which today's report day starts in `timezone` — the
 * instant companion to `todayReportDate`, so the claim branch and the
 * message-log fallback of the duplicate-report guard cannot define "today"
 * differently (#968). Previously the fallback used
 * `new Date().setHours(0, 0, 0, 0)`, i.e. midnight in the Node process's own
 * timezone, which is midnight UTC in the containers (no `TZ` is set) and so
 * started the window at 07:00 ICT.
 */
export function startOfReportDay(
  timezone = 'Asia/Ho_Chi_Minh',
  now = new Date(),
): Date {
  const { year, month, day } = getDatePartsInTimezone(now, timezone);
  return startOfReportDate(
    `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    timezone,
  );
}

/** Absolute instant at which a named report day starts in `timezone`. */
export function startOfReportDate(
  reportDate: string,
  timezone = 'Asia/Ho_Chi_Minh',
): Date {
  const [year, month, day] = reportDate.split('-').map(Number);
  const midnightAsIfUtc = Date.UTC(year, month - 1, day);
  // Probe both candidate offsets and keep the earliest instant that actually
  // starts on the requested date when a DST gap skips local midnight.
  const firstPass = new Date(
    midnightAsIfUtc - timezoneOffsetMs(timezone, new Date(midnightAsIfUtc)),
  );
  const secondPass = new Date(
    midnightAsIfUtc - timezoneOffsetMs(timezone, firstPass),
  );
  const firstStartsOnReportDate =
    todayInTimezone(timezone, firstPass) === reportDate;
  const secondStartsOnReportDate =
    todayInTimezone(timezone, secondPass) === reportDate;

  return firstStartsOnReportDate &&
    (!secondStartsOnReportDate || firstPass <= secondPass)
    ? firstPass
    : secondPass;
}

/** Absolute instant at which the day after a named report day starts. */
export function startOfNextReportDate(
  reportDate: string,
  timezone = 'Asia/Ho_Chi_Minh',
): Date {
  return startOfReportDate(
    tomorrowInTimezone(timezone, startOfReportDate(reportDate, timezone)),
    timezone,
  );
}

/** Milliseconds `timezone` is ahead of UTC at the given instant. */
function timezoneOffsetMs(timezone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const read = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);

  return (
    Date.UTC(
      read('year'),
      read('month') - 1,
      read('day'),
      read('hour'),
      read('minute'),
      read('second'),
    ) - at.getTime()
  );
}
