import { Injectable } from '@nestjs/common';
import type { ReschedulePort } from '@wispace/reschedule-confirm';
import type { RescheduleSchedulingMode } from '@wispace/wispace-client';
import { ZaloStudyCalendarCommandService } from '../../application/services/zalo-study-calendar-command.service';

@Injectable()
export class ZaloReschedulePort implements ReschedulePort<string> {
  constructor(
    private readonly studyCalendarCommandService: ZaloStudyCalendarCommandService,
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
      zaloUserId: params.externalId,
      userId: params.userId,
      calendarId: params.calendarId,
      schedulingMode: params.schedulingMode,
      newLocalDate: params.newLocalDate,
      newTime: params.newTime,
    });
    return { scheduledTimeLabel: result.scheduledTimeLabel };
  }
}
