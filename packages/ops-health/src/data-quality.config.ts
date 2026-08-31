import { ADVISORY_LOCKS } from '@wispace/bot-common/locks';
import type { DataQualityConfig } from './data-quality.types';

export const DATA_QUALITY_CRON_DEFAULT = 'production';
export const DATA_QUALITY_TIMEZONE = 'Asia/Ho_Chi_Minh';

export const DATA_QUALITY_DEFAULTS = {
  lockId: ADVISORY_LOCKS.DATA_QUALITY_CHECK,
  statementTimeoutMs: 5_000,
  sampleLimit: 5,
  timezone: DATA_QUALITY_TIMEZONE,
  baselineDays: 7,
  baselineMinRows: 10,
  futureSkewMs: 5 * 60_000,
  nullResolutionAgeMs: 24 * 60 * 60_000,
  stuckGraceMs: 5 * 60_000,
  stuckReservedMs: 10 * 60_000,
  webhookProcessingStuckMs: 5 * 60_000,
  studyReminderProcessingStuckMs: 10 * 60_000,
  reportSendProcessingStuckMs: 10 * 60_000,
  reportClaimProcessingStuckMs: 2 * 60 * 60_000,
  nullSpikeRatio: 2,
  nullSpikeMinCount: 10,
  nullSpikeMinRateDelta: 0.1,
  orphanGrowthRatio: 2,
  orphanMinDelta: 1,
  volumeLowRatio: 0.5,
  volumeHighRatio: 2,
} as const satisfies DataQualityConfig;

type EnvGetter = (key: string) => string | undefined;

function readPositiveNumber(
  get: EnvGetter,
  key: string,
  fallback: number,
): number {
  const raw = get(key)?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readRatio(get: EnvGetter, key: string, fallback: number): number {
  const value = readPositiveNumber(get, key, fallback);
  return value;
}

function readFraction(get: EnvGetter, key: string, fallback: number): number {
  const value = Number(get(key)?.trim());
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

function readBoolean(get: EnvGetter, key: string, fallback: boolean): boolean {
  const raw = get(key)?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  return fallback;
}

export function readDataQualityConfig(
  get: EnvGetter = (key) => process.env[key],
): DataQualityConfig {
  return {
    lockId: Math.floor(
      readPositiveNumber(
        get,
        'DATA_QUALITY_LOCK_ID',
        DATA_QUALITY_DEFAULTS.lockId,
      ),
    ),
    statementTimeoutMs: Math.floor(
      readPositiveNumber(
        get,
        'DATA_QUALITY_STATEMENT_TIMEOUT_MS',
        DATA_QUALITY_DEFAULTS.statementTimeoutMs,
      ),
    ),
    sampleLimit: Math.floor(
      readPositiveNumber(
        get,
        'DATA_QUALITY_SAMPLE_LIMIT',
        DATA_QUALITY_DEFAULTS.sampleLimit,
      ),
    ),
    timezone:
      get('DATA_QUALITY_TIMEZONE')?.trim() || DATA_QUALITY_DEFAULTS.timezone,
    baselineDays: Math.floor(
      readPositiveNumber(
        get,
        'DATA_QUALITY_BASELINE_DAYS',
        DATA_QUALITY_DEFAULTS.baselineDays,
      ),
    ),
    baselineMinRows: Math.floor(
      readPositiveNumber(
        get,
        'DATA_QUALITY_BASELINE_MIN_ROWS',
        DATA_QUALITY_DEFAULTS.baselineMinRows,
      ),
    ),
    futureSkewMs: Math.floor(
      readPositiveNumber(
        get,
        'DATA_QUALITY_FUTURE_SKEW_MS',
        DATA_QUALITY_DEFAULTS.futureSkewMs,
      ),
    ),
    nullResolutionAgeMs: Math.floor(
      readPositiveNumber(
        get,
        'DATA_QUALITY_NULL_RESOLUTION_AGE_MS',
        DATA_QUALITY_DEFAULTS.nullResolutionAgeMs,
      ),
    ),
    stuckGraceMs: Math.floor(
      readPositiveNumber(
        get,
        'DATA_QUALITY_STUCK_GRACE_MS',
        DATA_QUALITY_DEFAULTS.stuckGraceMs,
      ),
    ),
    stuckReservedMs: Math.floor(
      readPositiveNumber(
        get,
        'DATA_QUALITY_STUCK_RESERVED_MS',
        DATA_QUALITY_DEFAULTS.stuckReservedMs,
      ),
    ),
    webhookProcessingStuckMs: Math.floor(
      readPositiveNumber(
        get,
        'DATA_QUALITY_WEBHOOK_PROCESSING_STUCK_MS',
        DATA_QUALITY_DEFAULTS.webhookProcessingStuckMs,
      ),
    ),
    studyReminderProcessingStuckMs: Math.floor(
      readPositiveNumber(
        get,
        'DATA_QUALITY_STUDY_REMINDER_PROCESSING_STUCK_MS',
        DATA_QUALITY_DEFAULTS.studyReminderProcessingStuckMs,
      ),
    ),
    reportSendProcessingStuckMs: Math.floor(
      readPositiveNumber(
        get,
        'DATA_QUALITY_REPORT_SEND_PROCESSING_STUCK_MS',
        DATA_QUALITY_DEFAULTS.reportSendProcessingStuckMs,
      ),
    ),
    reportClaimProcessingStuckMs: Math.floor(
      readPositiveNumber(
        get,
        'DATA_QUALITY_REPORT_CLAIM_PROCESSING_STUCK_MS',
        DATA_QUALITY_DEFAULTS.reportClaimProcessingStuckMs,
      ),
    ),
    nullSpikeRatio: readRatio(
      get,
      'DATA_QUALITY_NULL_SPIKE_RATIO',
      DATA_QUALITY_DEFAULTS.nullSpikeRatio,
    ),
    nullSpikeMinCount: Math.floor(
      readPositiveNumber(
        get,
        'DATA_QUALITY_NULL_SPIKE_MIN_COUNT',
        DATA_QUALITY_DEFAULTS.nullSpikeMinCount,
      ),
    ),
    nullSpikeMinRateDelta: readFraction(
      get,
      'DATA_QUALITY_NULL_SPIKE_MIN_RATE_DELTA',
      DATA_QUALITY_DEFAULTS.nullSpikeMinRateDelta,
    ),
    orphanGrowthRatio: readRatio(
      get,
      'DATA_QUALITY_ORPHAN_GROWTH_RATIO',
      DATA_QUALITY_DEFAULTS.orphanGrowthRatio,
    ),
    orphanMinDelta: Math.floor(
      readPositiveNumber(
        get,
        'DATA_QUALITY_ORPHAN_MIN_DELTA',
        DATA_QUALITY_DEFAULTS.orphanMinDelta,
      ),
    ),
    volumeLowRatio: readFraction(
      get,
      'DATA_QUALITY_VOLUME_LOW_RATIO',
      DATA_QUALITY_DEFAULTS.volumeLowRatio,
    ),
    volumeHighRatio: readRatio(
      get,
      'DATA_QUALITY_VOLUME_HIGH_RATIO',
      DATA_QUALITY_DEFAULTS.volumeHighRatio,
    ),
  };
}

export function isDataQualityCronEnabled(
  get: EnvGetter = (key) => process.env[key],
  nodeEnv = get('NODE_ENV') ?? process.env.NODE_ENV,
): boolean {
  return readBoolean(
    get,
    'DATA_QUALITY_CRON_ENABLED',
    nodeEnv === DATA_QUALITY_CRON_DEFAULT,
  );
}
