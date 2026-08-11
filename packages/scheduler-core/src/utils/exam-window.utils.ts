import type { ReportScheduleService } from '../services/report-schedule.service';

export interface ExamWindowResult {
  examDate: string;
  shouldSend: boolean;
  daysUntilExam: number;
  minDays: number;
  maxDays: number;
}

/**
 * Resolves the exam window for a user, or null when the exam schedule cannot
 * be determined (Wispace unreachable / no exam date). Callers use this to
 * decide whether the 08:00 report cron should send today.
 */
export async function resolveExamWindow(
  externalUserId: string,
  reportScheduleService: ReportScheduleService,
): Promise<ExamWindowResult | null> {
  try {
    return await reportScheduleService.shouldSendReportToday(externalUserId);
  } catch {
    return null;
  }
}

/**
 * Shared window-gate decision for the 08:00 crons:
 * - `forceSend` bypasses the window entirely.
 * - Otherwise the report is skipped when the exam schedule is unknown or the
 *   exam is outside the configured days-before-exam window.
 * Returns the exam date (for the R5 outbox) or null.
 */
export async function resolveExamWindowOrNull(
  externalUserId: string,
  reportScheduleService: ReportScheduleService,
  forceSend: boolean,
): Promise<{ examDate: string | undefined; skip: boolean }> {
  const schedule = await resolveExamWindow(
    externalUserId,
    reportScheduleService,
  );
  if (forceSend) {
    return { examDate: schedule?.examDate, skip: false };
  }
  if (!schedule || !schedule.shouldSend) {
    return { examDate: undefined, skip: true };
  }
  return { examDate: schedule.examDate, skip: false };
}
