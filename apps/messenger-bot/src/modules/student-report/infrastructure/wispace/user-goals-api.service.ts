import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  buildWispaceHeaders,
  UserGoalsApiClient,
  type WispaceApiClientConfig,
} from '@wispace/wispace-client';
import { MetricsService } from '../../../metrics/metrics.service';
import type { UserGoalsRecord } from '@wispace/wispace-client';
import { parseExamDateToIso } from '../../../../shared/utils/exam-date.utils';

const ID_HEADER = 'x-psid' as const;

@Injectable()
export class UserGoalsApiService {
  private readonly logger = new Logger(UserGoalsApiService.name);
  private client?: UserGoalsApiClient;

  constructor(
    private readonly configService: ConfigService,
    private readonly metrics: MetricsService,
  ) {}

  async getUserGoals(psid: string): Promise<UserGoalsRecord> {
    return this.metrics.timeWispaceCall('UserGoals', 'get', () =>
      this.getClient().getUserGoals(ID_HEADER, psid),
    );
  }

  parseExamDate(examDate: string): string {
    try {
      return parseExamDateToIso(examDate);
    } catch {
      throw new InternalServerErrorException(
        `User goals API returned unsupported examDate format: ${examDate}`,
      );
    }
  }

  /** Also used by TaskScoreAverageApiService/UserCalendarApiService for shared auth headers. */
  buildWispaceHeaders(psid: string): Record<string, string> {
    if (!psid.trim()) {
      throw new InternalServerErrorException(
        'PSID is required for WISPACE API requests',
      );
    }

    return buildWispaceHeaders(ID_HEADER, psid, this.getInternalKey());
  }

  private getClient(): UserGoalsApiClient {
    if (!this.client) {
      this.client = new UserGoalsApiClient(this.buildClientConfig(), {
        warn: (m) => this.logger.warn(m),
        log: (m) => this.logger.log(m),
      });
    }

    return this.client;
  }

  private buildClientConfig(): WispaceApiClientConfig {
    return {
      url:
        this.configService.get<string>('WISPACE_API_USER_GOALS_URL') ??
        'https://backend.aihubproduction.com/api/User/goals',
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
}
