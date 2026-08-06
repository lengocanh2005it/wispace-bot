import { Injectable } from '@nestjs/common';
import type { CalendarEntryView } from '@wispace/reschedule-confirm';
import { GenericCalendarPort } from '@wispace/study-reminder-shared';
import { StudyCalendarCommandService } from '@messenger/modules/study-reminder/application/services/study-calendar-command.service';

@Injectable()
export class MessengerCalendarPort extends GenericCalendarPort {
  constructor(
    private readonly studyCalendarCommandService: StudyCalendarCommandService,
  ) {
    super(
      (psid: string, userId: number): Promise<CalendarEntryView[]> =>
        studyCalendarCommandService
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
