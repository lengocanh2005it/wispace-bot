export interface MessengerPrivacyCleanupSummary {
  pendingCount: number;
  processingCount: number;
  retryingCount: number;
  oldestPendingAgeSeconds: number | null;
}

export const PRIVACY_CLEANUP_SUMMARY_PORT = Symbol(
  'PRIVACY_CLEANUP_SUMMARY_PORT',
);

export interface PrivacyCleanupSummaryPort {
  getSummary(platform: 'messenger'): Promise<MessengerPrivacyCleanupSummary>;
}
