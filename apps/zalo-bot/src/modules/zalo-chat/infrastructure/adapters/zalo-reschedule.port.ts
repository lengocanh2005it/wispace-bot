import { Injectable } from '@nestjs/common';
import type { ReschedulePort } from '@wispace/reschedule-confirm';
import type { RescheduleSchedulingMode } from '@wispace/wispace-client';
import { PlatformStudyCalendarCommandService } from '@wispace/study-reminder-shared';

@Injectable()
export class ZaloReschedulePort implements ReschedulePort<string> {
  constructor(
    private readonly studyCalendarCommandService: PlatformStudyCalendarCommandService,
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
      externalUserId: params.externalId,
      userId: params.userId,
      calendarId: params.calendarId,
      schedulingMode: params.schedulingMode,
      newLocalDate: params.newLocalDate,
      newTime: params.newTime,
    });
    return { scheduledTimeLabel: result.scheduledTimeLabel };
  }
}
