import type { UserCalendarRecord } from '../entities/user-calendar.types';
import type { NormalizedStudySession } from '../entities/study-schedule.types';
import type { CalendarSessionTimeRange } from '@wispace/wispace-client';

/** Options accepted by `getCalendarSessions` on the WISPACE calendar source. */
export interface CalendarSessionsQuery {
  timeRange?: CalendarSessionTimeRange;
  userId?: number;
  pastDays?: number;
  limit?: number;
  signal?: AbortSignal;
}

/**
 * Authoritative WISPACE user-calendar data source for the study-calendar
 * command (list/reschedule). Implemented by the WISPACE HTTP clients in
 * `infrastructure/wispace/`; application code depends only on this port.
 */
export interface UserCalendarDataPort {
  listCalendars(
    psid: string,
    options?: { signal?: AbortSignal },
  ): Promise<UserCalendarRecord[]>;
  createCalendar(
    psid: string,
    input: { eventDate: string; time: string },
    options: { userId: number; signal?: AbortSignal },
  ): Promise<UserCalendarRecord>;
  deleteCalendar(
    psid: string,
    calendarId: number,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  getCalendarSessions(
    psid: string,
    horizonEnd: Date,
    options: CalendarSessionsQuery,
  ): Promise<NormalizedStudySession[]>;
  findCalendarRecord(
    psid: string,
    calendarId: number,
    options?: { signal?: AbortSignal },
  ): Promise<UserCalendarRecord | null>;
}

export const USER_CALENDAR_DATA_PORT = Symbol('USER_CALENDAR_DATA_PORT');
