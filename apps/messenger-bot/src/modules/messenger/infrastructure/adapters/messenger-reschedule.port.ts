import { Inject, Injectable } from '@nestjs/common';
import { GenericReschedulePort } from '@wispace/reschedule-confirm';
import {
  STUDY_REMINDER_OPERATIONS_PORT,
  type StudyReminderOperationsPort,
} from '@messenger/modules/study-reminder/domain/ports/study-reminder-operations.port';

@Injectable()
export class MessengerReschedulePort extends GenericReschedulePort {
  constructor(
    @Inject(STUDY_REMINDER_OPERATIONS_PORT)
    private readonly operations: StudyReminderOperationsPort,
  ) {
    super((params) =>
      operations.rescheduleSession({
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
