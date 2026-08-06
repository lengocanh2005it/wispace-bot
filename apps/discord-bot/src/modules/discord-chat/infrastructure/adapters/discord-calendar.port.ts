import { Injectable } from '@nestjs/common';
import type {
  CalendarPort,
  CalendarEntryView,
} from '@wispace/reschedule-confirm';
import { PlatformStudyCalendarCommandService } from '@wispace/study-reminder-shared';

@Injectable()
export class DiscordCalendarPort implements CalendarPort<string> {
  constructor(
    private readonly studyCalendarCommandService: PlatformStudyCalendarCommandService,
  ) {}

  async listUpcomingEntries(
    discordUserId: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _userId?: number,
  ): Promise<CalendarEntryView[]> {
    const upcoming = await this.studyCalendarCommandService.listEntries(
      discordUserId,
      { timeRange: 'upcoming' },
    );
    return upcoming.entries.map((entry) => ({
      calendarId: entry.calendarId,
      scheduledTimeLabel: entry.scheduledTimeLabel,
    }));
  }
}
