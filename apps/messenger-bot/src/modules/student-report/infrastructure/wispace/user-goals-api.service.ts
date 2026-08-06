import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  buildWispaceHeaders,
  UserGoalsApiClient,
} from '@wispace/wispace-client';
import { MetricsService } from '@messenger/modules/metrics/metrics.service';
import type { UserGoalsRecord } from '@wispace/wispace-client';
// ponytail: shared date utils live in scheduler-core (same byte-identical copy was local)
import { parseExamDateToIso } from '@wispace/scheduler-core';
import {
  buildWispaceClientConfig,
  getWispaceInternalKey,
} from './wispace-client-helpers';

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

    return buildWispaceHeaders(
      ID_HEADER,
      psid,
      getWispaceInternalKey(this.configService),
    );
  }

  private getClient(): UserGoalsApiClient {
    if (!this.client) {
      this.client = new UserGoalsApiClient(
        buildWispaceClientConfig(
          this.configService,
          'WISPACE_API_USER_GOALS_URL',
          'https://backend.aihubproduction.com/api/User/goals',
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
