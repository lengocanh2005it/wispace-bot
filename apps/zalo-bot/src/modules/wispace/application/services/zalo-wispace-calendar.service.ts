import { Injectable, Logger } from '@nestjs/common';
import {
  UserCalendarApiClient,
  UserCalendarScheduleClient,
  type CalendarSessionTimeRange,
  type CreateUserCalendarInput,
  type NormalizedStudySession,
  type UserCalendarRecord,
} from '@wispace/wispace-client';
import { ZaloWispaceConfigService } from './zalo-wispace-config.service';

const ID_HEADER = 'x-zaloid' as const;

@Injectable()
export class ZaloWispaceCalendarService {
  private readonly logger = new Logger(ZaloWispaceCalendarService.name);
  private apiClient?: UserCalendarApiClient;
  private scheduleClient?: UserCalendarScheduleClient;

  constructor(private readonly configService: ZaloWispaceConfigService) {}

  getCalendarSessions(
    zaloUserId: string,
    options: {
      timeRange?: CalendarSessionTimeRange;
      pastDays?: number;
      limit?: number;
    } = {},
  ): Promise<NormalizedStudySession[]> {
    const horizonEnd = new Date(Date.now() + 24 * 60 * 60 * 1000);

    return this.getScheduleClient().getCalendarSessions(
      ID_HEADER,
      zaloUserId,
      horizonEnd,
      { ...options, swallowErrors: true },
    );
  }

  listCalendars(zaloUserId: string): Promise<UserCalendarRecord[]> {
    return this.getApiClient().listCalendars(ID_HEADER, zaloUserId);
  }

  findCalendarRecord(
    zaloUserId: string,
    calendarId: number,
  ): Promise<UserCalendarRecord | null> {
    return this.getScheduleClient().findCalendarRecord(
      ID_HEADER,
      zaloUserId,
      calendarId,
    );
  }

  createCalendar(
    zaloUserId: string,
    input: CreateUserCalendarInput,
    options?: { userId?: number },
  ): Promise<UserCalendarRecord> {
    return this.getApiClient().createCalendar(
      ID_HEADER,
      zaloUserId,
      input,
      options,
    );
  }

  deleteCalendar(zaloUserId: string, calendarId: number): Promise<void> {
    return this.getApiClient().deleteCalendar(
      ID_HEADER,
      zaloUserId,
      calendarId,
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
