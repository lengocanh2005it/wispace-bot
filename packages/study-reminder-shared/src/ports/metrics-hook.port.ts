/**
 * Optional hook for dispatch metrics.
 * Messenger injects this; Discord/Zalo leave it undefined.
 */
export const METRICS_HOOK = Symbol('METRICS_HOOK');

export interface MetricsHook {
  onSent?(ctx: { jobId: number; externalUserId: string }): void;
  onFailed?(ctx: {
    jobId: number;
    externalUserId: string;
    error: string;
  }): void;
  onRetried?(ctx: {
    jobId: number;
    externalUserId: string;
    retryCount: number;
  }): void;
  onCancelled?(ctx: { jobId: number; externalUserId: string }): void;
}
