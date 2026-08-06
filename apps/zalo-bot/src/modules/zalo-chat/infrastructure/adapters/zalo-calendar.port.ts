import { Injectable } from '@nestjs/common';
import type {
  CalendarPort,
  CalendarEntryView,
} from '@wispace/reschedule-confirm';
import { WispaceCalendarService } from '@wispace/wispace-client';

@Injectable()
export class ZaloCalendarPort implements CalendarPort<string> {
  constructor(private readonly calendarService: WispaceCalendarService) {}

  async listUpcomingEntries(
    zaloUserId: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _userId?: number,
  ): Promise<CalendarEntryView[]> {
    const records = await this.calendarService.listCalendars(zaloUserId);
    return records.map((record) => ({
      calendarId: record.id,
      scheduledTimeLabel: `${record.eventDate} ${record.time ?? ''}`.trim(),
    }));
  }
}
