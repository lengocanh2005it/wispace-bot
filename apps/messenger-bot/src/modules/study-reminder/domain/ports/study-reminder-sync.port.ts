export const STUDY_REMINDER_SYNC_PORT = Symbol('STUDY_REMINDER_SYNC_PORT');

/** Messenger-owned seam for post-link reminder synchronization. */
export interface StudyReminderSyncPort {
  syncForUser(userId: number): Promise<void>;
}
