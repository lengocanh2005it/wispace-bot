import { StudyReminderJob } from '../../domain/entities/study-reminder-job.types';
import { NormalizedStudySession } from '../../domain/entities/study-schedule.types';
import { DEFAULT_TOPIC } from '@messenger/shared/config/poc.constants';

export function buildStudyReminderMessageType(
  session: NormalizedStudySession,
): string {
  return `STUDY_REMINDER:${session.scheduledAt.getTime()}`;
}

export function jobToSession(job: StudyReminderJob): NormalizedStudySession {
  return {
    sessionKey: job.sessionKey,
    scheduledAt: job.scheduledAt,
    topic: job.topic ?? DEFAULT_TOPIC,
  };
}
