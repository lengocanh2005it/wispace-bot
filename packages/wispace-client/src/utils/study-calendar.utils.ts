const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]?\d|2[0-3]):([0-5]\d)$/;

import {
  getDatePartsInTimezone,
  formatLocalDate as formatLocalDateInTimezone,
  tomorrowInTimezone,
} from '@wispace/date-utils';

export type RescheduleSchedulingMode =
  | 'default_next_day_same_time'
  | 'explicit';

export interface ResolvedStudyCalendarSlot {
  eventDate: string;
  time: string;
  localDate: string;
  schedulingMode: RescheduleSchedulingMode;
}

/** Local calendar date used internally after reschedule resolution. */
export function buildEventDateIso(localDate: string): string {
  if (!LOCAL_DATE_PATTERN.test(localDate)) {
    throw new Error(`localDate must be YYYY-MM-DD (received "${localDate}")`);
  }

  return localDate;
}

/** Wispace POST UserCalendar requires UTC DateTime for PostgreSQL timestamptz. */
export function formatEventDateForApiWrite(eventDate: string): string {
  const trimmed = eventDate.trim();
  if (LOCAL_DATE_PATTERN.test(trimmed)) {
    return `${trimmed}T00:00:00Z`;
  }

  if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
    return trimmed.endsWith('Z') ? trimmed : `${trimmed}Z`;
  }

  throw new Error(
    `eventDate must be YYYY-MM-DD or ISO-8601 (received "${eventDate}")`,
  );
}

export function parseLocalDatePartsFromEventDate(
  eventDate: string,
  timezone: string,
): { year: number; month: number; day: number } {
  const trimmed = eventDate.trim();
  if (LOCAL_DATE_PATTERN.test(trimmed)) {
    const [year, month, day] = trimmed.split('-').map(Number);
    return { year, month, day };
  }

  return getDatePartsInTimezone(new Date(trimmed), timezone);
}

export function resolveScheduledAtFromEventDate(
  eventDate: string,
  time: string,
  timezone: string,
): Date {
  const [hourText, minuteText] = time.split(':');
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const dateParts = parseLocalDatePartsFromEventDate(eventDate, timezone);
  const pad = (value: number) => String(value).padStart(2, '0');
  const offset = getUtcOffsetForTimezone(timezone, dateParts);

  return new Date(
    `${dateParts.year}-${pad(dateParts.month)}-${pad(dateParts.day)}T${pad(hour)}:${pad(minute)}:00${offset}`,
  );
}

function getUtcOffsetForTimezone(
  timezone: string,
  dateParts: { year: number; month: number; day: number },
): string {
  const probe = new Date(
    Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day, 12, 0, 0),
  );
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    timeZoneName: 'shortOffset',
  }).formatToParts(probe);
  const label = parts.find((part) => part.type === 'timeZoneName')?.value;

  if (!label || label === 'GMT') {
    return 'Z';
  }

  const match = label.match(/^GMT(?:(\+|-)(\d{1,2})(?::(\d{2}))?)?$/);
  if (!match) {
    return 'Z';
  }

  const sign = match[1] ?? '+';
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const pad = (value: number) => String(value).padStart(2, '0');

  return `${sign}${pad(hours)}:${pad(minutes)}`;
}

export function normalizeStudyCalendarTime(time: string): string {
  const trimmed = time.trim();
  const match = TIME_PATTERN.exec(trimmed);
  if (!match) {
    throw new Error(`time must be HH:mm (received "${time}")`);
  }

  const hour = match[1].padStart(2, '0');
  const minute = match[2];
  return `${hour}:${minute}`;
}

export function getLocalDateFromEventDate(
  eventDate: string,
  timezone: string,
): string {
  return formatLocalDateInTimezone(
    parseLocalDatePartsFromEventDate(eventDate, timezone),
  );
}

export function formatStoredCalendarDate(
  value: Date | string,
  timezone: string,
): string {
  if (value instanceof Date) {
    return formatLocalDateInTimezone(getDatePartsInTimezone(value, timezone));
  }

  const trimmed = String(value).trim();
  if (LOCAL_DATE_PATTERN.test(trimmed)) {
    return trimmed;
  }

  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    return getLocalDateFromEventDate(trimmed, timezone);
  }

  return trimmed;
}

export function addDaysToLocalDate(
  localDate: string,
  days: number,
  timezone: string,
): string {
  if (!LOCAL_DATE_PATTERN.test(localDate)) {
    throw new Error(`localDate must be YYYY-MM-DD (received "${localDate}")`);
  }

  const [year, month, day] = localDate.split('-').map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0));
  return formatLocalDateInTimezone(getDatePartsInTimezone(probe, timezone));
}

export function resolveRescheduleSlot(params: {
  schedulingMode: RescheduleSchedulingMode;
  sourceEventDate: string;
  sourceTime: string | null;
  newLocalDate?: string;
  newTime?: string;
  timezone: string;
  now?: Date;
}): ResolvedStudyCalendarSlot {
  const sourceTime = params.sourceTime?.trim();
  if (!sourceTime) {
    throw new Error('Buổi học hiện tại không có giờ (time) để dời lịch.');
  }

  const normalizedSourceTime = normalizeStudyCalendarTime(sourceTime);

  if (params.schedulingMode === 'default_next_day_same_time') {
    const sourceLocalDate = getLocalDateFromEventDate(
      params.sourceEventDate,
      params.timezone,
    );
    const localDate = addDaysToLocalDate(sourceLocalDate, 1, params.timezone);

    return {
      eventDate: buildEventDateIso(localDate),
      time: normalizedSourceTime,
      localDate,
      schedulingMode: params.schedulingMode,
    };
  }

  const localDate = params.newLocalDate?.trim();
  const explicitTime = params.newTime?.trim();

  if (!localDate && !explicitTime) {
    throw new Error(
      'schedulingMode=explicit requires newLocalDate and/or newTime.',
    );
  }

  const resolvedLocalDate =
    localDate ?? tomorrowInTimezone(params.timezone, params.now ?? new Date());

  if (!LOCAL_DATE_PATTERN.test(resolvedLocalDate)) {
    throw new Error(
      `newLocalDate must be YYYY-MM-DD (received "${resolvedLocalDate}")`,
    );
  }

  const resolvedTime = explicitTime
    ? normalizeStudyCalendarTime(explicitTime)
    : normalizedSourceTime;

  return {
    eventDate: buildEventDateIso(resolvedLocalDate),
    time: resolvedTime,
    localDate: resolvedLocalDate,
    schedulingMode: params.schedulingMode,
  };
}
