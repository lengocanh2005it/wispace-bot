import { StudyReminderJob } from '@wispace/study-reminder-shared/core';

export interface StudyReminderOpsSummary {
  countsByStatus: Record<string, number>;
  terminalFailedSince: number;
  stuckProcessing: number;
  failedHours: number;
  stuckProcessingMinutes: number;
  samples: {
    terminalFailed: StudyReminderJob[];
    stuckProcessing: StudyReminderJob[];
  };
}
