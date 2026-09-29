/** Result of the days-before-exam window check used by the report crons.
 *
 * Declared here rather than beside the schedule service so the framework-free
 * `/core` barrel does not have to reach out of its own directory to reach it
 * (#1454).
 */
export interface ExamWindowResult {
  shouldSend: boolean;
  daysUntilExam: number;
  examDate: string;
  minDays: number;
  maxDays: number;
}
