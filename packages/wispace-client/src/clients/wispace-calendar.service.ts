import { Injectable, Logger } from '@nestjs/common';
import { WispaceConfigService } from '../config/wispace-config.service';
import { hoursFromNow } from '@wispace/date-utils';
import type {
  CalendarSessionTimeRange,
  NormalizedStudySession,
} from '../types/study-schedule.types';
import type {
  CreateUserCalendarInput,
  UserCalendarRecord,
} from '../types/user-calendar.types';
import type { WispaceIdHeader } from '../utils/wispace-headers';
import { UserCalendarApiClient } from './user-calendar-api.client';
import { UserCalendarScheduleClient } from './user-calendar-schedule.client';

/**
 * Wispace user-calendar access — shared by Discord (`x-discordid`, env-driven
 * sync horizon) and Zalo (`x-zaloid`, fixed 24h horizon). The id-header and
 * horizon resolver are injected per app.
 */
@Injectable()
export class WispaceCalendarService {
  private readonly logger = new Logger(WispaceCalendarService.name);
  private apiClient?: UserCalendarApiClient;
  private scheduleClient?: UserCalendarScheduleClient;

  constructor(
    private readonly idHeader: WispaceIdHeader,
    private readonly configService: WispaceConfigService,
    private readonly horizonHours: () => number = () => 24,
  ) {}

  getCalendarSessions(
    externalUserId: string,
    options: {
      timeRange?: CalendarSessionTimeRange;
      pastDays?: number;
      limit?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<NormalizedStudySession[]> {
    const horizonEnd = hoursFromNow(this.horizonHours());

    return this.getScheduleClient().getCalendarSessions(
      this.idHeader,
      externalUserId,
      horizonEnd,
      options,
    );
  }

  listCalendars(
    externalUserId: string,
    options?: { signal?: AbortSignal },
  ): Promise<UserCalendarRecord[]> {
    return this.getApiClient().listCalendars(
      this.idHeader,
      externalUserId,
      options,
    );
  }

  findCalendarRecord(
    externalUserId: string,
    calendarId: number,
    options?: { signal?: AbortSignal },
  ): Promise<UserCalendarRecord | null> {
    return this.getScheduleClient().findCalendarRecord(
      this.idHeader,
      externalUserId,
      calendarId,
      options,
    );
  }

  createCalendar(
    externalUserId: string,
    input: CreateUserCalendarInput,
    options?: { userId?: number; signal?: AbortSignal },
  ): Promise<UserCalendarRecord> {
    return this.getApiClient().createCalendar(
      this.idHeader,
      externalUserId,
      input,
      options,
    );
  }

  deleteCalendar(
    externalUserId: string,
    calendarId: number,
    options?: { signal?: AbortSignal },
  ): Promise<void> {
    return this.getApiClient().deleteCalendar(
      this.idHeader,
      externalUserId,
      calendarId,
      options,
    );
  }

  private getApiClient(): UserCalendarApiClient {
    if (!this.apiClient) {
      this.apiClient = new UserCalendarApiClient(
        this.configService.buildCalendarClientConfig(),
        { warn: (m) => this.logger.warn(m), log: (m) => this.logger.log(m) },
      );
    }

    return this.apiClient;
  }

  private getScheduleClient(): UserCalendarScheduleClient {
    if (!this.scheduleClient) {
      this.scheduleClient = new UserCalendarScheduleClient(
        (idHeader, externalId) =>
          this.getApiClient().listCalendars(idHeader, externalId),
        this.configService.getTimezone(),
        { warn: (m) => this.logger.warn(m), log: (m) => this.logger.log(m) },
      );
    }

    return this.scheduleClient;
  }
}
