import { Injectable } from '@nestjs/common';
import type { UserCalendarRecord } from '../../domain/entities/user-calendar.types';
import type { NormalizedStudySession } from '../../domain/entities/study-schedule.types';
import type {
  CalendarSessionsQuery,
  UserCalendarDataPort,
} from '../../domain/ports/user-calendar-data.port';
import { UserCalendarApiService } from './user-calendar-api.service';
import { UserCalendarScheduleService } from './user-calendar-schedule.service';

/**
 * WISPACE HTTP implementation of `UserCalendarDataPort` — combines the raw
 * calendar CRUD client and the session normalizer behind the application seam.
 */
@Injectable()
export class UserCalendarDataAdapter implements UserCalendarDataPort {
  constructor(
    private readonly calendarApi: UserCalendarApiService,
    private readonly calendarSchedule: UserCalendarScheduleService,
  ) {}

  listCalendars(psid: string): Promise<UserCalendarRecord[]> {
    return this.calendarApi.listCalendars(psid);
  }

  createCalendar(
    psid: string,
    input: { eventDate: string; time: string },
    options: { userId: number },
  ): Promise<UserCalendarRecord> {
    return this.calendarApi.createCalendar(psid, input, options);
  }

  deleteCalendar(psid: string, calendarId: number): Promise<void> {
    return this.calendarApi.deleteCalendar(psid, calendarId);
  }

  getCalendarSessions(
    psid: string,
    horizonEnd: Date,
    options: CalendarSessionsQuery,
  ): Promise<NormalizedStudySession[]> {
    return this.calendarSchedule.getCalendarSessions(psid, horizonEnd, options);
  }

  findCalendarRecord(
    psid: string,
    calendarId: number,
  ): Promise<UserCalendarRecord | null> {
    return this.calendarSchedule.findCalendarRecord(psid, calendarId);
  }
}
