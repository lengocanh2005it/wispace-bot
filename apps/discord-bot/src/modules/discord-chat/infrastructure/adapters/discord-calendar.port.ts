import { Injectable } from '@nestjs/common';
import type { CalendarEntryView } from '@wispace/reschedule-confirm';
import {
  GenericCalendarPort,
  PlatformStudyCalendarCommandService,
} from '@wispace/study-reminder-shared';

@Injectable()
export class DiscordCalendarPort extends GenericCalendarPort {
  constructor(
    private readonly studyCalendarCommandService: PlatformStudyCalendarCommandService,
  ) {
    super(
      (externalId: string): Promise<CalendarEntryView[]> =>
        studyCalendarCommandService
          .listEntries(externalId, { timeRange: 'upcoming' })
          .then((result) =>
            result.entries.map((entry) => ({
              calendarId: entry.calendarId,
              scheduledTimeLabel: entry.scheduledTimeLabel,
            })),
          ),
    );
  }
}
