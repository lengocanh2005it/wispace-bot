import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserCalendarScheduleClient } from '@wispace/wispace-client';
import { resolveAppTimezone } from '@messenger/shared/config/app-timezone';
import { UserCalendarApiService } from './user-calendar-api.service';
import { UserCalendarRecord } from '../../domain/entities/user-calendar.types';
import {
  CalendarSessionTimeRange,
  NormalizedStudySession,
} from '../../domain/entities/study-schedule.types';

const ID_HEADER = 'x-psid' as const;

/**
 * Thin wrapper — the real listing/filtering/sorting logic lives in
 * `@wispace/wispace-client`'s `UserCalendarScheduleClient`, shared with
 * apps/discord-bot. This class only adapts the `psid` naming used by
 * messenger-bot's ports/callers to the package's generic `externalId`.
 */
@Injectable()
export class UserCalendarScheduleService {
  private readonly logger = new Logger(UserCalendarScheduleService.name);
  private client?: UserCalendarScheduleClient;

  constructor(
    private readonly userCalendarApiService: UserCalendarApiService,
    private readonly configService: ConfigService,
  ) {}

  async getUpcomingSessions(
    psid: string,
    horizonEnd: Date,
    userId?: number,
    options?: { signal?: AbortSignal },
  ): Promise<NormalizedStudySession[]> {
    return this.getCalendarSessions(psid, horizonEnd, {
      timeRange: 'upcoming',
      userId,
      ...(options?.signal ? { signal: options.signal } : {}),
    });
  }

  async findCalendarRecord(
    psid: string,
    calendarId: number,
    options?: { signal?: AbortSignal },
  ): Promise<UserCalendarRecord | null> {
    const records = options
      ? await this.userCalendarApiService.listCalendars(psid, options)
      : await this.userCalendarApiService.listCalendars(psid);
    return records.find((record) => record.id === calendarId) ?? null;
  }

  async getCalendarSessions(
    psid: string,
    horizonEnd: Date,
    options: {
      timeRange?: CalendarSessionTimeRange;
      userId?: number;
      pastDays?: number;
      limit?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<NormalizedStudySession[]> {
    return this.getClient().getCalendarSessions(ID_HEADER, psid, horizonEnd, {
      timeRange: options.timeRange,
      pastDays: options.pastDays,
      limit: options.limit,
      userId: options.userId,
      ...(options.signal ? { signal: options.signal } : {}),
      // Swallow only for unlinked accounts (no data is expected there). For
      // linked users an API failure must propagate: sync skips cancellation
      // and agent tools surface an error to the LLM instead of a fake empty list.
      swallowErrors: options.userId === undefined,
    });
  }

  private getClient(): UserCalendarScheduleClient {
    if (!this.client) {
      const timezone = resolveAppTimezone(this.configService);

      this.client = new UserCalendarScheduleClient(
        // The wrapped service already implements `listCalendars(psid)`;
        // adapt it to the package's `(idHeader, externalId)` client shape.
        (_idHeader, externalId, options) =>
          options
            ? this.userCalendarApiService.listCalendars(externalId, options)
            : this.userCalendarApiService.listCalendars(externalId),
        timezone,
        { warn: (m) => this.logger.warn(m), log: (m) => this.logger.log(m) },
      );
    }

    return this.client;
  }
}
