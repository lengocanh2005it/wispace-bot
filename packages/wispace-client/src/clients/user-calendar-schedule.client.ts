import { errorMessage, isAbortError } from '@wispace/bot-common';
import { WispaceApiError } from '../errors/wispace-api.error';
import { resolveScheduledAtFromEventDate } from '../utils/study-calendar.utils';
import type { UserCalendarApiClient } from './user-calendar-api.client';
import type { UserCalendarRecord } from '../types/user-calendar.types';
import type {
  CalendarSessionTimeRange,
  NormalizedStudySession,
} from '../types/study-schedule.types';
import type { WispaceIdHeader } from '../utils/wispace-headers';
import {
  NOOP_WISPACE_LOGGER,
  type WispaceClientLogger,
} from './wispace-client-types';
import { daysAgo } from '@wispace/date-utils';

/** Structural subset so callers can adapt their own list-calendars method without depending on the full client class. */
export type ListCalendarsFn = UserCalendarApiClient['listCalendars'];

export class UserCalendarScheduleClient {
  constructor(
    private readonly listCalendars: ListCalendarsFn,
    private readonly timezone: string,
    private readonly logger: WispaceClientLogger = NOOP_WISPACE_LOGGER,
  ) {}

  async getUpcomingSessions(
    idHeader: WispaceIdHeader,
    externalId: string,
    horizonEnd: Date,
    options?: { swallowErrors?: boolean; signal?: AbortSignal },
  ): Promise<NormalizedStudySession[]> {
    return this.getCalendarSessions(idHeader, externalId, horizonEnd, {
      timeRange: 'upcoming',
      swallowErrors: options?.swallowErrors,
      signal: options?.signal,
    });
  }

  async findCalendarRecord(
    idHeader: WispaceIdHeader,
    externalId: string,
    calendarId: number,
    options?: { signal?: AbortSignal },
  ): Promise<UserCalendarRecord | null> {
    const records = await this.listCalendars(idHeader, externalId, options);
    return records.find((record) => record.id === calendarId) ?? null;
  }

  async getCalendarSessions(
    idHeader: WispaceIdHeader,
    externalId: string,
    horizonEnd: Date,
    options: {
      timeRange?: CalendarSessionTimeRange;
      pastDays?: number;
      limit?: number;
      swallowErrors?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<NormalizedStudySession[]> {
    const timeRange = options.timeRange ?? 'upcoming';
    const pastDays = options.pastDays ?? 90;

    try {
      const records = await this.listCalendars(idHeader, externalId, options);
      let sessions = records
        .map((record) => this.buildSession(record))
        .filter(
          (session): session is NormalizedStudySession => session !== null,
        );

      sessions = this.filterSessionsByTimeRange(sessions, {
        timeRange,
        horizonEnd,
        pastDays,
      });
      sessions = this.sortSessions(sessions, timeRange);

      if (options.limit && options.limit > 0) {
        sessions = sessions.slice(0, options.limit);
      }

      return sessions;
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      if (!options.swallowErrors) {
        throw error;
      }

      this.logCalendarApiFailure(idHeader, externalId, error);
      return [];
    }
  }

  private buildSession(
    record: UserCalendarRecord,
  ): NormalizedStudySession | null {
    const scheduledAt = this.resolveScheduledAt(record.eventDate, record.time);
    if (Number.isNaN(scheduledAt.getTime())) {
      return null;
    }

    return {
      sessionKey: `calendar:${record.id}`,
      scheduledAt,
      topic: 'IELTS Writing',
    };
  }

  private filterSessionsByTimeRange(
    sessions: NormalizedStudySession[],
    params: {
      timeRange: CalendarSessionTimeRange;
      horizonEnd: Date;
      pastDays: number;
    },
  ): NormalizedStudySession[] {
    const now = Date.now();
    const upcomingCutoff = now - 60 * 60 * 1000;
    const pastCutoff = daysAgo(params.pastDays).getTime();

    return sessions.filter((session) => {
      const scheduledAtMs = session.scheduledAt.getTime();

      if (params.timeRange === 'upcoming') {
        return (
          scheduledAtMs > upcomingCutoff &&
          scheduledAtMs <= params.horizonEnd.getTime()
        );
      }

      if (params.timeRange === 'past') {
        return scheduledAtMs <= upcomingCutoff && scheduledAtMs >= pastCutoff;
      }

      return (
        scheduledAtMs >= pastCutoff &&
        scheduledAtMs <= params.horizonEnd.getTime()
      );
    });
  }

  private sortSessions(
    sessions: NormalizedStudySession[],
    timeRange: CalendarSessionTimeRange,
  ): NormalizedStudySession[] {
    const sorted = [...sessions].sort(
      (left, right) => left.scheduledAt.getTime() - right.scheduledAt.getTime(),
    );

    if (timeRange === 'past') {
      sorted.reverse();
    }

    return sorted;
  }

  private resolveScheduledAt(eventDate: string, time: string | null): Date {
    const trimmedTime = time?.trim();
    if (!trimmedTime) {
      return new Date(eventDate);
    }

    return resolveScheduledAtFromEventDate(
      eventDate,
      trimmedTime,
      this.timezone,
    );
  }

  private logCalendarApiFailure(
    idHeader: WispaceIdHeader,
    externalId: string,
    error: unknown,
  ): void {
    const message = errorMessage(error);
    const unknownId =
      error instanceof WispaceApiError && error.statusCode === 401;

    if (unknownId) {
      this.logger.log(
        `UserCalendar skipped for ${idHeader}=${externalId} — Wispace does not recognize this id`,
      );
      return;
    }

    this.logger.warn(
      `UserCalendar API failed for ${idHeader}=${externalId}: ${message}`,
    );
  }
}
