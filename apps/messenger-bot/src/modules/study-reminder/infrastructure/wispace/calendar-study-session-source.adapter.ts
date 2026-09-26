import { Injectable } from '@nestjs/common';
import type { NormalizedStudySession } from '../../domain/entities/study-schedule.types';
import type { StudySessionSourcePort } from '../../domain/ports/study-session-source.port';
import { UserCalendarScheduleService } from './user-calendar-schedule.service';

/** Adapts the calendar client to the application-facing session source. */
@Injectable()
export class CalendarStudySessionSourceAdapter implements StudySessionSourcePort {
  constructor(
    private readonly userCalendarScheduleService: UserCalendarScheduleService,
  ) {}

  getUpcomingSessions(params: {
    psid: string;
    userId?: number;
    horizonEnd: Date;
  }): Promise<NormalizedStudySession[]> {
    return this.userCalendarScheduleService.getUpcomingSessions(
      params.psid,
      params.horizonEnd,
      params.userId,
    );
  }
}
