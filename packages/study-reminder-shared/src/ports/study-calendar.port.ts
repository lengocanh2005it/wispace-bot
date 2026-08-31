import type {
  CalendarSessionTimeRange,
  CreateUserCalendarInput,
  UserCalendarRecord,
} from '@wispace/wispace-client';

/**
 * Structural surface of the write-capable WISPACE calendar client, consumed
 * by `PlatformStudyCalendarCommandService`. Concrete adapters are wired at
 * each bot's composition root — the shared package never imports the class
 * (#424).
 */
export interface StudyCalendarPort {
  listCalendars(
    externalUserId: string,
    options?: { signal?: AbortSignal },
  ): Promise<UserCalendarRecord[]>;
  getCalendarSessions(
    externalUserId: string,
    options?: {
      timeRange?: CalendarSessionTimeRange;
      pastDays?: number;
      limit?: number;
      /** Local defense-in-depth scope for normalized calendar reads. */
      userId?: number;
      signal?: AbortSignal;
    },
  ): Promise<Array<{ sessionKey: string; scheduledAt: Date; topic?: string }>>;
  findCalendarRecord(
    externalUserId: string,
    calendarId: number,
    options?: { signal?: AbortSignal },
  ): Promise<UserCalendarRecord | null>;
  createCalendar(
    externalUserId: string,
    input: CreateUserCalendarInput,
    options?: { userId?: number; signal?: AbortSignal },
  ): Promise<UserCalendarRecord>;
  deleteCalendar(
    externalUserId: string,
    calendarId: number,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
}

/** Timezone + lead-time policy consumed by the reschedule scheduling math. */
export interface RescheduleConfigPort {
  getTimezone(): string;
  getMinLeadMinutes(): number;
}
