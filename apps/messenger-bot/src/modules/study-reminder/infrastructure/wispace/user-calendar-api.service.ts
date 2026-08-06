import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserCalendarApiClient } from '@wispace/wispace-client';
import { MetricsService } from '@messenger/modules/metrics/metrics.service';
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
    private readonly metrics: MetricsService,
  ) {}

  async listCalendars(psid: string): Promise<UserCalendarRecord[]> {
    return this.metrics.timeWispaceCall('UserCalendar', 'list', () =>
      this.getClient().listCalendars(ID_HEADER, psid),
    );
  }

  async createCalendar(
    psid: string,
    input: CreateUserCalendarInput,
    options?: { userId?: number },
  ): Promise<UserCalendarRecord> {
    return this.metrics.timeWispaceCall('UserCalendar', 'create', () =>
      this.getClient().createCalendar(ID_HEADER, psid, input, options),
    );
  }

  async deleteCalendar(psid: string, calendarId: number): Promise<void> {
    return this.metrics.timeWispaceCall('UserCalendar', 'delete', () =>
      this.getClient().deleteCalendar(ID_HEADER, psid, calendarId),
    );
  }

  private getClient(): UserCalendarApiClient {
    if (!this.client) {
      this.client = new UserCalendarApiClient(
        buildWispaceClientConfig(
          this.configService,
          'WISPACE_API_USER_CALENDAR_URL',
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
