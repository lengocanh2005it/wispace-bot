import { maskExternalId, sanitizeLogValue } from '@wispace/bot-common/masking';
import type {
  DataQualityCheckName,
  DataQualityCheckResult,
  DataQualityConfig,
  DataQualityObservation,
  DataQualitySample,
} from './data-quality.types';

function sum(values: Array<number | null | undefined>): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

function hasInsufficientBaseline(
  check: DataQualityCheckName,
  observations: DataQualityObservation[],
  config: DataQualityConfig,
): boolean {
  if (
    check !== 'null_spike' &&
    check !== 'orphan_growth' &&
    check !== 'volume_anomalies'
  ) {
    return false;
  }

  const baselineRows = sum(
    observations.map((observation) => observation.baselineTotalCount),
  );
  return baselineRows < config.baselineMinRows;
}

function nullSpikeExceeded(
  observation: DataQualityObservation,
  config: DataQualityConfig,
): boolean {
  const baseline = observation.baselineCount ?? 0;
  const count = Math.max(0, observation.count);
  if (count < config.nullSpikeMinCount) return false;

  const ratioExceeded =
    baseline === 0 || count >= baseline * config.nullSpikeRatio;
  const currentRate =
    observation.totalCount && observation.totalCount > 0
      ? count / observation.totalCount
      : null;
  const baselineRate =
    observation.baselineTotalCount && observation.baselineTotalCount > 0
      ? baseline / observation.baselineTotalCount
      : null;
  const rateExceeded =
    currentRate !== null &&
    baselineRate !== null &&
    currentRate - baselineRate >= config.nullSpikeMinRateDelta;

  return ratioExceeded || rateExceeded;
}

function orphanGrowthExceeded(
  observation: DataQualityObservation,
  config: DataQualityConfig,
): boolean {
  const baseline = Math.max(0, observation.baselineCount ?? 0);
  const count = Math.max(0, observation.count);
  const delta = count - baseline;
  if (delta < config.orphanMinDelta) return false;
  return baseline === 0 || count >= baseline * config.orphanGrowthRatio;
}

function volumeExceeded(
  observation: DataQualityObservation,
  config: DataQualityConfig,
): boolean {
  const baseline = Math.max(0, observation.baselineCount ?? 0);
  const count = Math.max(0, observation.count);
  if (baseline === 0) return count > 0;
  return (
    count < baseline * config.volumeLowRatio ||
    count > baseline * config.volumeHighRatio
  );
}

function isExceeded(
  check: DataQualityCheckName,
  observation: DataQualityObservation,
  config: DataQualityConfig,
): boolean {
  switch (check) {
    case 'null_spike':
      return nullSpikeExceeded(observation, config);
    case 'orphan_growth':
      return orphanGrowthExceeded(observation, config);
    case 'volume_anomalies':
      return volumeExceeded(observation, config);
    case 'future_timestamps':
    case 'terminal_timestamps':
    case 'stuck_states':
      return observation.count > 0;
  }
}

function thresholdFor(
  check: DataQualityCheckName,
  observations: DataQualityObservation[],
  config: DataQualityConfig,
): number | null {
  const baseline = sum(
    observations.map((observation) => observation.baselineCount),
  );
  switch (check) {
    case 'null_spike':
      return Math.max(
        config.nullSpikeMinCount,
        baseline * config.nullSpikeRatio,
      );
    case 'orphan_growth':
      return Math.max(
        config.orphanMinDelta,
        baseline * config.orphanGrowthRatio,
      );
    case 'volume_anomalies':
      return baseline * config.volumeHighRatio;
    default:
      return null;
  }
}

export function evaluateDataQualityCheck(
  check: DataQualityCheckName,
  observations: DataQualityObservation[],
  config: DataQualityConfig,
): DataQualityCheckResult {
  const normalized =
    observations.length > 0 ? observations : [{ scope: 'none', count: 0 }];
  const count = sum(normalized.map((observation) => observation.count));
  const baseline = normalized.some(
    (observation) => observation.baselineCount !== undefined,
  )
    ? sum(normalized.map((observation) => observation.baselineCount))
    : null;
  const insufficient = hasInsufficientBaseline(check, normalized, config);

  if (insufficient) {
    return {
      check,
      status: 'pass',
      count,
      baseline,
      threshold: thresholdFor(check, normalized, config),
      sampleKeys: [],
      reason: 'baseline_insufficient',
    };
  }

  const failed = normalized.filter((observation) =>
    isExceeded(check, observation, config),
  );

  return {
    check,
    status: failed.length > 0 ? 'fail' : 'pass',
    count,
    baseline,
    threshold: thresholdFor(check, normalized, config),
    sampleKeys: failed
      .flatMap((observation) => observation.samples ?? [])
      .slice(0, config.sampleLimit)
      .map(formatDataQualitySample),
    ...(failed.length > 0 ? { reason: 'threshold_exceeded' as const } : {}),
  };
}

export function formatDataQualitySample(sample: DataQualitySample): string {
  const parts = [sanitizeLogValue(sample.table, 64)];
  if (sample.key !== undefined) {
    parts.push(`key=${maskExternalId(sample.key)}`);
  }
  if (sample.externalUserId !== undefined) {
    parts.push(`external=${maskExternalId(sample.externalUserId)}`);
  }
  if (sample.userId !== undefined) {
    parts.push(`user=${maskExternalId(sample.userId)}`);
  }
  if (sample.label) {
    parts.push(sanitizeLogValue(sample.label, 64));
  }
  return parts.join(';');
}
