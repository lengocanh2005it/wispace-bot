/** Metrics adapter for cleanup jobs, implemented by each bot's own registry. */
export const RETENTION_CLEANUP_METRICS_PORT = Symbol(
  'RETENTION_CLEANUP_METRICS_PORT',
);

export interface RetentionCleanupMetricsPort {
  registerPolicy(name: string): void;
  incRowsDeleted(name: string, count: number): void;
  incCleanupError(name: string): void;
  incLlmUsageDeleted(count: number): void;
}
