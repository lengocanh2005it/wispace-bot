import { Injectable, Logger } from '@nestjs/common';
import { StudyReminderScheduleService } from './study-reminder-schedule.service';
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
      params.horizonEnd ??
      new Date(Date.now() + syncHorizonHours * 60 * 60 * 1000);

    try {
      return await this.userCalendarScheduleService.getUpcomingSessions(
        params.psid,
        horizonEnd,
        params.userId,
      );
    } catch (error) {
      this.logger.error(
        `Failed to load study sessions for psid=${params.psid}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw error;
    }
  }
}
