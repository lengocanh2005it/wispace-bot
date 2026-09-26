import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { errorMessage, maskExternalId } from '@wispace/bot-common/masking';
import { readSyncHorizonHours } from '@wispace/study-reminder-shared/core';
import { addHours } from 'date-fns';
import { NormalizedStudySession } from '../../domain/entities/study-schedule.types';
import {
  STUDY_SESSION_SOURCE,
  type StudySessionSourcePort,
} from '../../domain/ports/study-session-source.port';

@Injectable()
export class StudySessionSourceService {
  private readonly logger = new Logger(StudySessionSourceService.name);

  constructor(
    @Inject(STUDY_SESSION_SOURCE)
    private readonly sessionSource: StudySessionSourcePort,
    private readonly configService: ConfigService,
  ) {}

  async getUpcomingSessions(params: {
    psid: string;
    userId?: number;
    horizonEnd?: Date;
  }): Promise<NormalizedStudySession[]> {
    const horizonEnd =
      params.horizonEnd ??
      addHours(
        new Date(),
        readSyncHorizonHours((key: string) =>
          this.configService.get<string>(key),
        ),
      );

    try {
      return await this.sessionSource.getUpcomingSessions({
        psid: params.psid,
        userId: params.userId,
        horizonEnd,
      });
    } catch (error) {
      this.logger.error(
        `Failed to load study sessions for psid=${maskExternalId(
          params.psid,
        )}: ${errorMessage(error)}`,
      );
      throw error;
    }
  }
}
