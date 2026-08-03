export interface DopplerWebhookPayload {
  project?: { name?: string } | string;
  config?: { name?: string } | string;
  type?: string;
}

export interface DopplerRuntimeSyncResult {
  accepted: boolean;
  skipped?: boolean;
  reason?: string;
}
