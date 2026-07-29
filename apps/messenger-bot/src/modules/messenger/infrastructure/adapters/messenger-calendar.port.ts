import { Injectable } from '@nestjs/common';
import type {
  CalendarPort,
  CalendarEntryView,
} from '@wispace/reschedule-confirm';
import { StudyCalendarCommandService } from '@messenger/modules/study-reminder/application/services/study-calendar-command.service';

@Injectable()
export class MessengerCalendarPort implements CalendarPort<string> {
  constructor(
    private readonly studyCalendarCommandService: StudyCalendarCommandService,
  ) {}

  async listUpcomingEntries(
    psid: string,
    userId: number,
  ): Promise<CalendarEntryView[]> {
    const upcoming = await this.studyCalendarCommandService.listEntries(
      psid,
      userId,
      { timeRange: 'upcoming' },
    );
    return upcoming.entries.map((entry) => ({
      calendarId: entry.calendarId,
      scheduledTimeLabel: entry.scheduledTimeLabel,
    }));
  }
}
