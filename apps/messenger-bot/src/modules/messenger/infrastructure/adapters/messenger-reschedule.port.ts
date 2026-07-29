import { Injectable } from '@nestjs/common';
import type { ReschedulePort } from '@wispace/reschedule-confirm';
import type { RescheduleSchedulingMode } from '@wispace/wispace-client';
import { StudyCalendarCommandService } from '@messenger/modules/study-reminder/application/services/study-calendar-command.service';

@Injectable()
export class MessengerReschedulePort implements ReschedulePort<string> {
  constructor(
    private readonly studyCalendarCommandService: StudyCalendarCommandService,
  ) {}

  async rescheduleSession(params: {
    externalId: string;
    userId: number;
    calendarId: number;
    schedulingMode: RescheduleSchedulingMode;
    newLocalDate?: string;
    newTime?: string;
  }): Promise<{ scheduledTimeLabel: string }> {
    const result = await this.studyCalendarCommandService.rescheduleSession({
      psid: params.externalId,
      userId: params.userId,
      calendarId: params.calendarId,
      schedulingMode: params.schedulingMode,
      newLocalDate: params.newLocalDate,
      newTime: params.newTime,
    });
    return { scheduledTimeLabel: result.scheduledTimeLabel };
  }
}
