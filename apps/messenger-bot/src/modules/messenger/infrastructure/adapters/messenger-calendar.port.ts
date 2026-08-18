import { Inject, Injectable } from '@nestjs/common';
import type { CalendarEntryView } from '@wispace/reschedule-confirm';
import { GenericCalendarPort } from '@wispace/study-reminder-shared';
import {
  STUDY_REMINDER_OPERATIONS_PORT,
  type StudyReminderOperationsPort,
} from '@messenger/modules/study-reminder/domain/ports/study-reminder-operations.port';

@Injectable()
export class MessengerCalendarPort extends GenericCalendarPort {
  constructor(
    @Inject(STUDY_REMINDER_OPERATIONS_PORT)
    private readonly operations: StudyReminderOperationsPort,
  ) {
    super((psid: string, userId: number): Promise<CalendarEntryView[]> =>
      operations
        .listEntries(psid, userId, { timeRange: 'upcoming' })
        .then((result) =>
          result.entries.map((entry) => ({
            calendarId: entry.calendarId,
            scheduledTimeLabel: entry.scheduledTimeLabel,
          })),
        ),
    );
  }
}
