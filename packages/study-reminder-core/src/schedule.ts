/** Pure timezone-aware study reminder scheduling math — no I/O, no config reads. */
import { getDatePartsInTimezone as getDatePartsFromUtils } from '@wispace/date-utils';

export function computeRemindAt(
  scheduledAt: Date,
  minutesBefore: number,
): Date {
  return new Date(scheduledAt.getTime() - minutesBefore * 60 * 1000);
}

export function getMinutesUntilSession(
  scheduledAt: Date,
  now: Date = new Date(),
): number {
  return (scheduledAt.getTime() - now.getTime()) / (1000 * 60);
}

export function isSessionStarted(
  scheduledAt: Date,
  minLeadMinutes: number,
  now: Date = new Date(),
): boolean {
  return getMinutesUntilSession(scheduledAt, now) <= minLeadMinutes;
}

/** "Hôm nay lúc HH:mm" / "Ngày mai lúc HH:mm" / "dd/MM/yyyy lúc HH:mm" (vi-VN). */
export function formatScheduledTimeLabel(
  scheduledAt: Date,
  timezone: string,
  now: Date = new Date(),
): string {
  const todayParts = getDatePartsFromUtils(now, timezone);
  const sessionParts = getDatePartsFromUtils(scheduledAt, timezone);

  const isToday =
    todayParts.year === sessionParts.year &&
    todayParts.month === sessionParts.month &&
    todayParts.day === sessionParts.day;

  const tomorrowProbe = new Date(
    Date.UTC(
      todayParts.year,
      todayParts.month - 1,
      todayParts.day + 1,
      12,
      0,
      0,
    ),
  );
  const tomorrowParts = getDatePartsFromUtils(tomorrowProbe, timezone);
  const isTomorrow =
    tomorrowParts.year === sessionParts.year &&
    tomorrowParts.month === sessionParts.month &&
    tomorrowParts.day === sessionParts.day;

  const timeText = new Intl.DateTimeFormat('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timezone,
  }).format(scheduledAt);

  if (isToday) {
    return `Hôm nay lúc ${timeText}`;
  }

  if (isTomorrow) {
    return `Ngày mai lúc ${timeText}`;
  }

  const dateText = new Intl.DateTimeFormat('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: timezone,
  }).format(scheduledAt);

  return `${dateText} lúc ${timeText}`;
}
