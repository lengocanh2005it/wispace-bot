export interface StudyReminderSyncResult {
  scope: 'all' | 'user';
  userId?: number;
  linked: boolean;
  mappings: number;
  upserted: number;
  cancelled: number;
  cancelledOtherPlatforms: number;
  skipped: number;
  failures: Array<{ psid: string; error: string }>;
}
