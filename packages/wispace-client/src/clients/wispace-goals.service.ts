import { Injectable, Logger } from '@nestjs/common';
import { WispaceConfigService } from '../config/wispace-config.service';
import type { TaskScoreAverageRecord } from '../types/task-score-average.types';
import type { UserGoalsRecord } from '../types/user-goals.types';
import type { WispaceIdHeader } from '../utils/wispace-headers';
import { TaskScoreAverageApiClient } from './task-score-average-api.client';
import { UserGoalsApiClient } from './user-goals-api.client';

/**
 * Wispace goals/task-score access — shared by Discord (`x-discordid`) and
 * Zalo (`x-zaloid`); the id-header is injected per app.
 */
@Injectable()
export class WispaceGoalsService {
  private readonly logger = new Logger(WispaceGoalsService.name);
  private goalsClient?: UserGoalsApiClient;
  private taskScoreClient?: TaskScoreAverageApiClient;

  constructor(
    private readonly idHeader: WispaceIdHeader,
    private readonly configService: WispaceConfigService,
  ) {}

  getUserGoals(externalUserId: string): Promise<UserGoalsRecord> {
    return this.getGoalsClient().getUserGoals(this.idHeader, externalUserId);
  }

  getTaskScoreAverages(
    externalUserId: string,
  ): Promise<TaskScoreAverageRecord[]> {
    return this.getTaskScoreClient().getTaskScoreAverages(
      this.idHeader,
      externalUserId,
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
