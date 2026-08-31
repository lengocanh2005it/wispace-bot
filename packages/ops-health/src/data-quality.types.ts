export const DATA_QUALITY_CHECK_NAMES = [
  'null_spike',
  'future_timestamps',
  'terminal_timestamps',
  'stuck_states',
  'orphan_growth',
  'volume_anomalies',
] as const;

export type DataQualityCheckName = (typeof DATA_QUALITY_CHECK_NAMES)[number];

export type DataQualityResultStatus = 'pass' | 'fail';

export interface DataQualitySample {
  table: string;
  key?: string | number | null;
  userId?: string | number | null;
  externalUserId?: string | null;
  label?: string;
}

export interface DataQualityObservation {
  scope: string;
  count: number;
  baselineCount?: number | null;
  totalCount?: number | null;
  baselineTotalCount?: number | null;
  samples?: DataQualitySample[];
}

export interface DataQualityCheckResult {
  check: DataQualityCheckName;
  status: DataQualityResultStatus;
  count: number;
  baseline: number | null;
  threshold: number | null;
  sampleKeys: string[];
  reason?: 'threshold_exceeded' | 'baseline_insufficient' | 'query_error';
}

export interface DataQualityRunResult {
  generatedAt: string;
  status: 'pass' | 'fail' | 'skipped';
  durationMs: number;
  lock: 'acquired' | 'skipped';
  checks: DataQualityCheckResult[];
}

export interface DataQualityConfig {
  lockId: number;
  statementTimeoutMs: number;
  sampleLimit: number;
  timezone: string;
  baselineDays: number;
  baselineMinRows: number;
  futureSkewMs: number;
  nullResolutionAgeMs: number;
  stuckGraceMs: number;
  stuckReservedMs: number;
  webhookProcessingStuckMs: number;
  studyReminderProcessingStuckMs: number;
  reportSendProcessingStuckMs: number;
  reportClaimProcessingStuckMs: number;
  nullSpikeRatio: number;
  nullSpikeMinCount: number;
  nullSpikeMinRateDelta: number;
  orphanGrowthRatio: number;
  orphanMinDelta: number;
  volumeLowRatio: number;
  volumeHighRatio: number;
}

export interface DataQualityQueryWindow {
  now: Date;
  currentStart: Date;
  currentEnd: Date;
  baselineStart: Date;
  baselineEnd: Date;
}

export interface DataQualityQueryInput {
  config: DataQualityConfig;
  window: DataQualityQueryWindow;
}

export interface DataQualityRepositoryPort {
  getNullSpikeObservations(
    input: DataQualityQueryInput,
  ): Promise<DataQualityObservation[]>;
  getFutureTimestampObservations(
    input: DataQualityQueryInput,
  ): Promise<DataQualityObservation[]>;
  getTerminalTimestampObservations(
    input: DataQualityQueryInput,
  ): Promise<DataQualityObservation[]>;
  getStuckStateObservations(
    input: DataQualityQueryInput,
  ): Promise<DataQualityObservation[]>;
  getOrphanGrowthObservations(
    input: DataQualityQueryInput,
  ): Promise<DataQualityObservation[]>;
  getVolumeObservations(
    input: DataQualityQueryInput,
  ): Promise<DataQualityObservation[]>;
}

export interface DataQualityLockPort {
  withLock<T>(lockId: number, fn: () => Promise<T>): Promise<T | null>;
}

export interface DataQualityDatabasePort {
  withReadOnly<T>(
    timeoutMs: number,
    operation: (query: DataQualityQueryPort) => Promise<T>,
  ): Promise<T>;
}

export interface DataQualityQueryPort {
  query<T>(sql: string, parameters?: readonly unknown[]): Promise<T[]>;
}

export interface DataQualityMetricsPort {
  setCheckStatus(
    check: DataQualityCheckName,
    status: DataQualityResultStatus,
  ): void;
  incRun(outcome: 'pass' | 'fail' | 'skipped'): void;
  incFailure(check: DataQualityCheckName): void;
}
