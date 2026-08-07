import { Inject, Injectable } from '@nestjs/common';
import type {
  StudyDataPort,
  StudySessionView,
  StudyCalendarEntryView,
  StudyOutboxSettings,
  StudyReminderLlmOutput,
  CalendarSessionTimeRange,
} from '../../domain/ports/study-data.port';
import { StudyReminderScheduleService } from '@wispace/study-reminder-shared';
import {
  STUDY_REMINDER_OPERATIONS_PORT,
  type StudyReminderOperationsPort,
} from '@messenger/modules/study-reminder/domain/ports/study-reminder-operations.port';

@Injectable()
export class StudyDataAdapter implements StudyDataPort {
  constructor(
    @Inject(STUDY_REMINDER_OPERATIONS_PORT)
    private readonly operations: StudyReminderOperationsPort,
    private readonly scheduleService: StudyReminderScheduleService,
  ) {}

  async getUpcomingSessions(params: {
    psid: string;
    userId?: number;
    horizonEnd?: Date;
  }): Promise<StudySessionView[]> {
    const sessions = await this.operations.getUpcomingSessions(params);
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
    const session = await this.operations.getNextUpcomingSession(psid, userId);
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
    const bundle = await this.operations.generateReminderBundleForSession(
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
    return this.operations.listEntries(psid, userId, options);
  }

  getOutboxSettings(): StudyOutboxSettings {
    return this.scheduleService.getOutboxSettings();
  }

  formatScheduledTimeLabel(scheduledAt: Date, now?: Date): string {
    return this.scheduleService.formatScheduledTimeLabel(scheduledAt, now);
  }
}
