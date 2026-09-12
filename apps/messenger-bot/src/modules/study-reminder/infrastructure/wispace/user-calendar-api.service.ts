import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserCalendarApiClient } from '@wispace/wispace-client';
import { BotMetricsService } from '@wispace/bot-metrics';
import {
  CreateUserCalendarInput,
  UserCalendarRecord,
} from '../../domain/entities/user-calendar.types';
import { buildWispaceClientConfig } from '../../../student-report/infrastructure/wispace/wispace-client-helpers';

const ID_HEADER = 'x-psid' as const;

@Injectable()
export class UserCalendarApiService {
  private readonly logger = new Logger(UserCalendarApiService.name);
  private client?: UserCalendarApiClient;

  constructor(
    private readonly configService: ConfigService,
    private readonly metrics: BotMetricsService,
  ) {}

  async listCalendars(
    psid: string,
    options?: { signal?: AbortSignal },
  ): Promise<UserCalendarRecord[]> {
    return options
      ? this.getClient().listCalendars(ID_HEADER, psid, options)
      : this.getClient().listCalendars(ID_HEADER, psid);
  }

  async createCalendar(
    psid: string,
    input: CreateUserCalendarInput,
    options?: { userId?: number; signal?: AbortSignal },
  ): Promise<UserCalendarRecord> {
    return options
      ? this.getClient().createCalendar(ID_HEADER, psid, input, options)
      : this.getClient().createCalendar(ID_HEADER, psid, input);
  }

  async deleteCalendar(
    psid: string,
    calendarId: number,
    options?: { signal?: AbortSignal },
  ): Promise<void> {
    return options
      ? this.getClient().deleteCalendar(ID_HEADER, psid, calendarId, options)
      : this.getClient().deleteCalendar(ID_HEADER, psid, calendarId);
  }

  private getClient(): UserCalendarApiClient {
    if (!this.client) {
      this.client = new UserCalendarApiClient(
        buildWispaceClientConfig(
          this.configService,
          'WISPACE_API_USER_CALENDAR_URL',
          undefined,
          this.metrics,
        ),
        {
          warn: (m) => this.logger.warn(m),
          log: (m) => this.logger.log(m),
        },
      );
    }

    return this.client;
  }
}
