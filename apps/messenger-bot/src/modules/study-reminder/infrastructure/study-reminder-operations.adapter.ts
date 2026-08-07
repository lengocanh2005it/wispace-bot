import { Injectable } from '@nestjs/common';
import type {
  StudyReminderOperationsPort,
  CalendarSessionTimeRange,
  NormalizedStudySession,
} from '../domain/ports/study-reminder-operations.port';
import type { StudyReminderLlmOutput } from '../domain/entities/study-schedule.types';
import type { StudyCalendarEntryView } from '@wispace/reschedule-confirm';
import type { RescheduleSchedulingMode } from '@wispace/wispace-client';
import { StudySessionSourceService } from '../application/services/study-session-source.service';
import { StudyReminderService } from '../application/services/study-reminder.service';
import { StudyCalendarCommandService } from '../application/services/study-calendar-command.service';

@Injectable()
export class StudyReminderOperationsAdapter implements StudyReminderOperationsPort {
  constructor(
    private readonly sessionSource: StudySessionSourceService,
    private readonly reminderService: StudyReminderService,
    private readonly calendarCommand: StudyCalendarCommandService,
  ) {}

  async getUpcomingSessions(params: {
    psid: string;
    userId?: number;
    horizonEnd?: Date;
  }): Promise<NormalizedStudySession[]> {
    return this.sessionSource.getUpcomingSessions(params);
  }

  async getNextUpcomingSession(
    psid: string,
    userId?: number,
  ): Promise<NormalizedStudySession | null> {
    return this.reminderService.getNextUpcomingSession(psid, userId);
  }

  async generateReminderBundleForSession(
    psid: string,
    session: NormalizedStudySession,
    options?: { userId?: number; displayName?: string; jobId?: number },
  ): Promise<{ text: string; output: StudyReminderLlmOutput }> {
    return this.reminderService.generateReminderBundleForSession(
      psid,
      session,
      options,
    );
  }

  async listEntries(
    psid: string,
    userId?: number,
    options?: {
      timeRange?: CalendarSessionTimeRange;
      limit?: number;
      pastDays?: number;
    },
  ): Promise<{
    timeRange: CalendarSessionTimeRange;
    entries: StudyCalendarEntryView[];
  }> {
    return this.calendarCommand.listEntries(psid, userId, options);
  }

  async rescheduleSession(params: {
    psid: string;
    userId: number;
    calendarId: number;
    schedulingMode: RescheduleSchedulingMode;
    newLocalDate?: string;
    newTime?: string;
  }): Promise<{ scheduledTimeLabel: string }> {
    return this.calendarCommand.rescheduleSession({
      psid: params.psid,
      userId: params.userId,
      calendarId: params.calendarId,
      schedulingMode: params.schedulingMode,
      newLocalDate: params.newLocalDate,
      newTime: params.newTime,
    });
  }
}
