import type {
  ReminderGeneratorPort,
  StudySessionRecord,
} from '@wispace/study-reminder-shared';
import { StudyReminderService } from '../../application/services/study-reminder.service';
import type { NormalizedStudySession } from '../../domain/entities/study-schedule.types';

/**
 * Adapts Messenger's LLM-based StudyReminderService to the shared
 * ReminderGeneratorPort. The shared dispatch service calls this
 * to generate Vietnamese LLM reminders instead of plain-text templates.
 */
export class MessengerReminderGeneratorAdapter implements ReminderGeneratorPort {
  constructor(private readonly studyReminderService: StudyReminderService) {}

  async generate(
    session: StudySessionRecord,
    ctx: {
      externalUserId: string;
      userId?: number;
      timeLabel: string;
      minutesUntil: number;
    },
  ): Promise<string> {
    const normalizedSession: NormalizedStudySession = {
      sessionKey: session.sessionKey,
      scheduledAt: session.scheduledAt,
      topic: session.topic ?? 'học tập',
    };

    return this.studyReminderService.generateReminderForSession(
      ctx.externalUserId,
      normalizedSession,
      { userId: ctx.userId },
    );
  }
}
