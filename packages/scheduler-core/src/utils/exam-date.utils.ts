export function calendarDateToUtcMs(isoDate: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim());
  if (!match) {
    throw new Error(`Invalid calendar date: ${isoDate}`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return Date.UTC(year, month - 1, day);
}

export function daysBetweenCalendarDates(from: string, to: string): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round(
    (calendarDateToUtcMs(to) - calendarDateToUtcMs(from)) / msPerDay,
  );
}

export function resolveExamCountdown(
  examDate: string,
  currentDate: string,
): { daysUntilExam: number; examHasPassed: boolean } {
  const rawDays = daysBetweenCalendarDates(currentDate, examDate);
  return {
    daysUntilExam: Math.max(0, rawDays),
    examHasPassed: rawDays < 0,
  };
}

const EXAM_DATE_DISPLAY_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: 'UTC',
});

export function formatExamDateDisplay(isoDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate.trim())) {
    return isoDate;
  }
  return EXAM_DATE_DISPLAY_FORMATTER.format(new Date(isoDate));
}

export function parseExamDateToIso(examDate: string): string {
  const trimmed = examDate.trim();
  const slashMatch = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(trimmed);
  if (slashMatch) {
    const [, day, month, year] = slashMatch;
    return `${year}-${month}-${day}`;
  }

  const isoDateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (isoDateMatch) {
    return trimmed;
  }

  const isoDateTimeMatch = /^(\d{4})-(\d{2})-(\d{2})[T\s]/.exec(trimmed);
  if (isoDateTimeMatch) {
    return `${isoDateTimeMatch[1]}-${isoDateTimeMatch[2]}-${isoDateTimeMatch[3]}`;
  }

  throw new Error(`Unsupported examDate format: ${examDate}`);
}

export function rawDaysUntilExam(
  examDate: string,
  currentDate: string,
): number {
  return daysBetweenCalendarDates(currentDate, examDate);
}
