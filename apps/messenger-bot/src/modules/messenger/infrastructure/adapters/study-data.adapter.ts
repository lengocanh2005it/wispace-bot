import { Injectable } from '@nestjs/common';
import type {
  StudyDataPort,
  StudySessionView,
  StudyCalendarEntryView,
  StudyOutboxSettings,
  StudyReminderLlmOutput,
  CalendarSessionTimeRange,
} from '../../domain/ports/study-data.port';
import { StudySessionSourceService } from '../../../study-reminder/application/services/study-session-source.service';
import { StudyReminderService } from '../../../study-reminder/application/services/study-reminder.service';
import { StudyReminderScheduleService } from '../../../study-reminder/application/services/study-reminder-schedule.service';
import { StudyCalendarCommandService } from '../../../study-reminder/application/services/study-calendar-command.service';

@Injectable()
export class StudyDataAdapter implements StudyDataPort {
  constructor(
    private readonly sessionSource: StudySessionSourceService,
    private readonly reminderService: StudyReminderService,
    private readonly scheduleService: StudyReminderScheduleService,
    private readonly calendarCommand: StudyCalendarCommandService,
  ) {}

  async getUpcomingSessions(params: {
    psid: string;
    userId?: number;
    horizonEnd?: Date;
  }): Promise<StudySessionView[]> {
    const sessions = await this.sessionSource.getUpcomingSessions(params);
    return sessions.map((s) => ({
      sessionKey: s.sessionKey,
      scheduledAt: s.scheduledAt,
      topic: s.topic,
      durationMinutes: s.durationMinutes,
    }));
  }

  async getNextUpcomingSession(
    psid: string,
    userId?: number,
  ): Promise<StudySessionView | null> {
    const session = await this.reminderService.getNextUpcomingSession(
      psid,
      userId,
    );
    if (!session) return null;
    return {
      sessionKey: session.sessionKey,
      scheduledAt: session.scheduledAt,
      topic: session.topic,
      durationMinutes: session.durationMinutes,
    };
  }

  async generateReminderBundleForSession(
    psid: string,
    session: StudySessionView,
    options?: { userId?: number; displayName?: string; jobId?: number },
  ): Promise<{ text: string; output: StudyReminderLlmOutput }> {
    const bundle = await this.reminderService.generateReminderBundleForSession(
      psid,
      {
        sessionKey: session.sessionKey,
        scheduledAt: session.scheduledAt,
        topic: session.topic,
        durationMinutes: session.durationMinutes,
      },
      options,
    );
    return {
      text: bundle.text,
      output: bundle.output,
    };
  }

  listCalendarEntries(
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

  getOutboxSettings(): StudyOutboxSettings {
    return this.scheduleService.getOutboxSettings();
  }

  formatScheduledTimeLabel(scheduledAt: Date, now?: Date): string {
    return this.scheduleService.formatScheduledTimeLabel(scheduledAt, now);
  }
}
