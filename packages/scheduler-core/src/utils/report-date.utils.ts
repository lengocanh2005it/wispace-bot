import { todayInTimezone } from '@wispace/date-utils';

/** ICT calendar date for scheduled report idempotency (R4). */
export function todayReportDate(
  timezone = 'Asia/Ho_Chi_Minh',
  now = new Date(),
): string {
  return todayInTimezone(timezone, now);
}
