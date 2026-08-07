import {
  subMilliseconds,
  subMinutes,
  subHours,
  subDays,
  addMinutes,
  addHours,
  addDays,
} from 'date-fns';

/** Subtract milliseconds from a date. */
export function subtractMs(date: Date, ms: number): Date {
  return subMilliseconds(date, ms);
}

/** Date N minutes ago. */
export function minutesAgo(n: number, now: Date = new Date()): Date {
  return subMinutes(now, n);
}

/** Date N hours ago. */
export function hoursAgo(n: number, now: Date = new Date()): Date {
  return subHours(now, n);
}

/** Date N days ago. */
export function daysAgo(n: number, now: Date = new Date()): Date {
  return subDays(now, n);
}

/** Date N minutes from now. */
export function minutesFromNow(n: number, now: Date = new Date()): Date {
  return addMinutes(now, n);
}

/** Date N hours from now. */
export function hoursFromNow(n: number, now: Date = new Date()): Date {
  return addHours(now, n);
}

/** Date N days from now. */
export function daysFromNow(n: number, now: Date = new Date()): Date {
  return addDays(now, n);
}

/** YYYY-MM-DD date parts in a given IANA timezone (e.g. Asia/Ho_Chi_Minh). */
export function getDatePartsInTimezone(
  date: Date,
  timezone: string,
): { year: number; month: number; day: number } {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const [year, month, day] = formatter.format(date).split('-').map(Number);
  return { year, month, day };
}

/** Formats date parts as YYYY-MM-DD. */
export function formatLocalDate(parts: {
  year: number;
  month: number;
  day: number;
}): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

/** Today's local calendar date (YYYY-MM-DD) in the given timezone. */
export function todayInTimezone(
  timezone: string,
  now: Date = new Date(),
): string {
  return formatLocalDate(getDatePartsInTimezone(now, timezone));
}

/** Tomorrow's local calendar date (YYYY-MM-DD) in the given timezone. */
export function tomorrowInTimezone(
  timezone: string,
  now: Date = new Date(),
): string {
  const today = getDatePartsInTimezone(now, timezone);
  const probe = new Date(
    Date.UTC(today.year, today.month - 1, today.day + 1, 12, 0, 0),
  );
  return formatLocalDate(getDatePartsInTimezone(probe, timezone));
}
