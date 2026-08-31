import type {
  DataQualityCheckName,
  DataQualityCheckResult,
  DataQualityConfig,
  DataQualityLockPort,
  DataQualityMetricsPort,
  DataQualityQueryInput,
  DataQualityQueryWindow,
  DataQualityRepositoryPort,
  DataQualityRunResult,
} from './data-quality.types';
import { evaluateDataQualityCheck } from './data-quality.evaluator';

const CHECKS: Array<{
  name: DataQualityCheckName;
  load: (
    repository: DataQualityRepositoryPort,
    input: DataQualityQueryInput,
  ) => ReturnType<DataQualityRepositoryPort['getNullSpikeObservations']>;
}> = [
  {
    name: 'null_spike',
    load: (repository, input) => repository.getNullSpikeObservations(input),
  },
  {
    name: 'future_timestamps',
    load: (repository, input) =>
      repository.getFutureTimestampObservations(input),
  },
  {
    name: 'terminal_timestamps',
    load: (repository, input) =>
      repository.getTerminalTimestampObservations(input),
  },
  {
    name: 'stuck_states',
    load: (repository, input) => repository.getStuckStateObservations(input),
  },
  {
    name: 'orphan_growth',
    load: (repository, input) => repository.getOrphanGrowthObservations(input),
  },
  {
    name: 'volume_anomalies',
    load: (repository, input) => repository.getVolumeObservations(input),
  },
];

export class DataQualityService {
  constructor(
    private readonly repository: DataQualityRepositoryPort,
    private readonly lock: DataQualityLockPort,
    private readonly config: DataQualityConfig,
    private readonly metrics?: DataQualityMetricsPort,
  ) {}

  async run(now = new Date()): Promise<DataQualityRunResult> {
    const startedAt = Date.now();
    const generatedAt = now.toISOString();
    let result: DataQualityCheckResult[] | null;
    try {
      result = await this.lock.withLock(this.config.lockId, async () => {
        const input: DataQualityQueryInput = {
          config: this.config,
          window: buildDataQualityQueryWindow(now, this.config),
        };
        const checks: DataQualityCheckResult[] = [];

        for (const check of CHECKS) {
          try {
            const observations = await check.load(this.repository, input);
            checks.push(
              evaluateDataQualityCheck(check.name, observations, this.config),
            );
          } catch {
            checks.push({
              check: check.name,
              status: 'fail',
              count: 0,
              baseline: null,
              threshold: null,
              sampleKeys: [],
              reason: 'query_error',
            });
          }
        }

        return checks;
      });
    } catch {
      this.metrics?.incRun('fail');
      throw new Error('data_quality_run_failed');
    }

    if (result === null) {
      this.metrics?.incRun('skipped');
      return {
        generatedAt,
        status: 'skipped',
        durationMs: Date.now() - startedAt,
        lock: 'skipped',
        checks: [],
      };
    }

    const status = result.some((check) => check.status === 'fail')
      ? 'fail'
      : 'pass';
    for (const check of result) {
      this.metrics?.setCheckStatus(check.check, check.status);
      if (check.status === 'fail') {
        this.metrics?.incFailure(check.check);
      }
    }
    this.metrics?.incRun(status);

    return {
      generatedAt,
      status,
      durationMs: Date.now() - startedAt,
      lock: 'acquired',
      checks: result,
    };
  }
}

export function buildDataQualityQueryWindow(
  now: Date,
  config: DataQualityConfig,
): DataQualityQueryWindow {
  const localParts = getDateParts(now, config.timezone);
  const localToday = Date.UTC(
    localParts.year,
    localParts.month - 1,
    localParts.day,
  );
  const currentEnd = fromLocalDate(localToday, config.timezone);
  const currentStart = fromLocalDate(
    localToday - 24 * 60 * 60_000,
    config.timezone,
  );
  const baselineStart = fromLocalDate(
    localToday - (config.baselineDays + 1) * 24 * 60 * 60_000,
    config.timezone,
  );

  return {
    now,
    currentStart,
    currentEnd,
    baselineStart,
    baselineEnd: currentStart,
  };
}

function getDateParts(
  date: Date,
  timeZone: string,
): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<string, number>;
  return {
    year: values.year,
    month: values.month,
    day: values.day,
  };
}

function fromLocalDate(localUtcMs: number, timeZone: string): Date {
  let candidate = localUtcMs;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = getDateTimeParts(new Date(candidate), timeZone);
    const renderedAsUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    candidate = localUtcMs - (renderedAsUtc - candidate);
  }
  return new Date(candidate);
}

function getDateTimeParts(
  date: Date,
  timeZone: string,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<string, number>;
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
}
