import { todayInTimezone } from '@wispace/date-utils';

export function todayUsageDate(timezone: string, now = new Date()): string {
  return todayInTimezone(timezone, now);
}
