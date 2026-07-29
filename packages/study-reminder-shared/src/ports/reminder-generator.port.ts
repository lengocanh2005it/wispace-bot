import type { StudySessionRecord } from '../types/study-reminder.types';

/**
 * Optional port for LLM-generated reminder messages.
 * Messenger injects this; Discord/Zalo leave it undefined (uses template).
 */
export const REMINDER_GENERATOR = Symbol('REMINDER_GENERATOR');

export interface ReminderGeneratorPort {
  generate(
    session: StudySessionRecord,
    ctx: {
      externalUserId: string;
      userId?: number;
      timeLabel: string;
      minutesUntil: number;
    },
  ): Promise<string>;
}
