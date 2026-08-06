import { Injectable } from '@nestjs/common';
import { GenericReschedulePort } from '@wispace/reschedule-confirm';
import { StudyCalendarCommandService } from '@messenger/modules/study-reminder/application/services/study-calendar-command.service';

@Injectable()
export class MessengerReschedulePort extends GenericReschedulePort {
  constructor(studyCalendarCommandService: StudyCalendarCommandService) {
    super((params) =>
      studyCalendarCommandService.rescheduleSession({
        psid: params.externalUserId,
        userId: params.userId,
        calendarId: params.calendarId,
        schedulingMode: params.schedulingMode,
        newLocalDate: params.newLocalDate,
        newTime: params.newTime,
      }),
    );
  }
}
