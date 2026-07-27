import { Injectable, Logger } from '@nestjs/common';
import {
  TaskScoreAverageApiClient,
  UserGoalsApiClient,
  type TaskScoreAverageRecord,
  type UserGoalsRecord,
} from '@wispace/wispace-client';
import { ZaloWispaceConfigService } from './zalo-wispace-config.service';

const ID_HEADER = 'x-zaloid' as const;

@Injectable()
export class ZaloWispaceGoalsService {
  private readonly logger = new Logger(ZaloWispaceGoalsService.name);
  private goalsClient?: UserGoalsApiClient;
  private taskScoreClient?: TaskScoreAverageApiClient;

  constructor(private readonly configService: ZaloWispaceConfigService) {}

  getUserGoals(zaloUserId: string): Promise<UserGoalsRecord> {
    return this.getGoalsClient().getUserGoals(ID_HEADER, zaloUserId);
  }

  getTaskScoreAverages(zaloUserId: string): Promise<TaskScoreAverageRecord[]> {
    return this.getTaskScoreClient().getTaskScoreAverages(
      ID_HEADER,
      zaloUserId,
    );
  }

  private getGoalsClient(): UserGoalsApiClient {
    if (!this.goalsClient) {
      this.goalsClient = new UserGoalsApiClient(
        this.configService.buildGoalsClientConfig(),
        { warn: (m) => this.logger.warn(m), log: (m) => this.logger.log(m) },
      );
    }

    return this.goalsClient;
  }

  private getTaskScoreClient(): TaskScoreAverageApiClient {
    if (!this.taskScoreClient) {
      this.taskScoreClient = new TaskScoreAverageApiClient(
        this.configService.buildTaskScoreClientConfig(),
        { warn: (m) => this.logger.warn(m), log: (m) => this.logger.log(m) },
      );
    }

    return this.taskScoreClient;
  }
}
