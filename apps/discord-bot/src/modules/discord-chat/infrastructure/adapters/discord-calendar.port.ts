import { Injectable } from '@nestjs/common';
import type {
  CalendarPort,
  CalendarEntryView,
} from '@wispace/reschedule-confirm';
import { DiscordStudyCalendarCommandService } from '@discord/modules/wispace/application/services/discord-study-calendar-command.service';

@Injectable()
export class DiscordCalendarPort implements CalendarPort<string> {
  constructor(
    private readonly studyCalendarCommandService: DiscordStudyCalendarCommandService,
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
