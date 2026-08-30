/**
 * Student data (goals / capacity bands) used to enrich study reminders.
 * Implemented by the WISPACE HTTP clients in `infrastructure/wispace/`;
 * application code depends only on this port.
 */
export interface ReminderStudentDataPort {
  getUserGoals(
    psid: string,
  ): Promise<{ targetScore?: number; examDate?: string }>;
  getCapacityData(psid: string): Promise<{
    task1_band?: number | null;
    task2_band?: number | null;
    target_band?: number | null;
  }>;
}

export const REMINDER_STUDENT_DATA_PORT = Symbol('REMINDER_STUDENT_DATA_PORT');
