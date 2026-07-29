import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  UserCalendarApiClient,
  type WispaceApiClientConfig,
} from '@wispace/wispace-client';
import { MetricsService } from '@messenger/modules/metrics/metrics.service';
import {
  CreateUserCalendarInput,
  UserCalendarRecord,
} from '../../domain/entities/user-calendar.types';

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
      this.client = new UserCalendarApiClient(this.buildClientConfig(), {
        warn: (m) => this.logger.warn(m),
        log: (m) => this.logger.log(m),
      });
    }

    return this.client;
  }

  private buildClientConfig(): WispaceApiClientConfig {
    return {
      url: this.getBaseUrl(),
      internalKey: this.getInternalKey(),
      maxRetries: this.readPositiveInt('WISPACE_API_MAX_RETRIES', 3),
      baseDelayMs: this.readPositiveInt('WISPACE_API_RETRY_BASE_DELAY_MS', 500),
    };
  }

  private getInternalKey(): string {
    const key = this.configService.get<string>('WISPACE_INTERNAL_KEY')?.trim();
    if (!key) {
      throw new InternalServerErrorException(
        'WISPACE_INTERNAL_KEY must be set in .env',
      );
    }

    return key;
  }

  private readPositiveInt(key: string, defaultValue: number): number {
    const raw = this.configService.get<string>(key)?.trim();
    if (!raw) return defaultValue;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : defaultValue;
  }

  private getBaseUrl(): string {
    const url = this.configService
      .get<string>('WISPACE_API_USER_CALENDAR_URL')
      ?.trim();

    if (!url) {
      throw new InternalServerErrorException(
        'WISPACE_API_USER_CALENDAR_URL must be set in .env',
      );
    }

    return url;
  }
}
