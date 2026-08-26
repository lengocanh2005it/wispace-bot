import { Injectable, Logger } from '@nestjs/common';
import { errorMessage, maskExternalId } from '@wispace/bot-common';
import { StudyReminderScheduleService } from '@wispace/study-reminder-shared';
import { addHours } from 'date-fns';
import { NormalizedStudySession } from '../../domain/entities/study-schedule.types';
import { UserCalendarScheduleService } from '../../infrastructure/wispace/user-calendar-schedule.service';

@Injectable()
export class StudySessionSourceService {
  private readonly logger = new Logger(StudySessionSourceService.name);

  constructor(
    private readonly userCalendarScheduleService: UserCalendarScheduleService,
    private readonly studyReminderScheduleService: StudyReminderScheduleService,
  ) {}

  async getUpcomingSessions(params: {
    psid: string;
    userId?: number;
    horizonEnd?: Date;
  }): Promise<NormalizedStudySession[]> {
    const { syncHorizonHours } =
      this.studyReminderScheduleService.getOutboxSettings();
    const horizonEnd =
      params.horizonEnd ?? addHours(new Date(), syncHorizonHours);

    try {
      return await this.userCalendarScheduleService.getUpcomingSessions(
        params.psid,
        horizonEnd,
        params.userId,
      );
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
