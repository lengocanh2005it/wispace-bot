import { Injectable } from '@nestjs/common';
import type {
  ReschedulePort,
  RescheduleResult,
} from '@wispace/reschedule-confirm';
import type { RescheduleSchedulingMode } from '@wispace/wispace-client';
import { DiscordStudyCalendarCommandService } from '@discord/modules/wispace/application/services/discord-study-calendar-command.service';

@Injectable()
export class DiscordReschedulePort implements ReschedulePort<string> {
  constructor(
    private readonly studyCalendarCommandService: DiscordStudyCalendarCommandService,
  ) {}

  async rescheduleSession(params: {
    externalId: string;
    userId: number;
    calendarId: number;
    schedulingMode: RescheduleSchedulingMode;
    newLocalDate?: string;
    newTime?: string;
  }): Promise<RescheduleResult> {
    const result = await this.studyCalendarCommandService.rescheduleSession({
      discordUserId: params.externalId,
      userId: params.userId,
      calendarId: params.calendarId,
      schedulingMode: params.schedulingMode,
      newLocalDate: params.newLocalDate,
      newTime: params.newTime,
    });
    return { scheduledTimeLabel: result.scheduledTimeLabel };
  }
}
