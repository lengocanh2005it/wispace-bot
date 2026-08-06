import { Injectable } from '@nestjs/common';
import { GenericReschedulePort } from '@wispace/reschedule-confirm';
import { PlatformStudyCalendarCommandService } from '@wispace/study-reminder-shared';

@Injectable()
export class DiscordReschedulePort extends GenericReschedulePort {
  constructor(
    studyCalendarCommandService: PlatformStudyCalendarCommandService,
  ) {
    super((params) => studyCalendarCommandService.rescheduleSession(params));
  }
}
