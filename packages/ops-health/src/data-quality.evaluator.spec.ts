import { DATA_QUALITY_DEFAULTS } from './data-quality.config';
import {
  evaluateDataQualityCheck,
  formatDataQualitySample,
} from './data-quality.evaluator';
import type {
  DataQualityConfig,
  DataQualityObservation,
} from './data-quality.types';

const config: DataQualityConfig = { ...DATA_QUALITY_DEFAULTS };

function observation(
  overrides: Partial<DataQualityObservation> = {},
): DataQualityObservation {
  return {
    scope: 'chat_daily_usage',
    count: 0,
    ...overrides,
  };
}

describe('evaluateDataQualityCheck', () => {
  it('flags a null spike and preserves only masked samples', () => {
    const result = evaluateDataQualityCheck(
      'null_spike',
      [
        observation({
          count: 20,
          baselineCount: 4,
          totalCount: 100,
          baselineTotalCount: 100,
          samples: [
            { table: 'chat_daily_usage', key: 12345678901234, userId: 42 },
          ],
        }),
      ],
      config,
    );

    expect(result.status).toBe('fail');
    expect(result.count).toBe(20);
    expect(result.reason).toBe('threshold_exceeded');
    expect(result.sampleKeys).toEqual([
      'chat_daily_usage;key=1234…1234;user=42…',
    ]);
    expect(result.sampleKeys.join(' ')).not.toContain('12345678901234');
  });

  it('flags each non-baseline anomaly class when a row exists', () => {
    for (const check of [
      'future_timestamps',
      'terminal_timestamps',
      'stuck_states',
    ] as const) {
      const result = evaluateDataQualityCheck(
        check,
        [observation({ count: 1, samples: [{ table: 'jobs', key: 7 }] })],
        config,
      );
      expect(result.status).toBe('fail');
      expect(result.reason).toBe('threshold_exceeded');
    }
  });

  it('flags orphan growth from a zero baseline', () => {
    const result = evaluateDataQualityCheck(
      'orphan_growth',
      [observation({ count: 1, baselineCount: 0, baselineTotalCount: 20 })],
      config,
    );

    expect(result.status).toBe('fail');
    expect(result.threshold).toBe(1);
  });

  it('flags volume collapse and surge against the median baseline', () => {
    const collapse = evaluateDataQualityCheck(
      'volume_anomalies',
      [observation({ count: 4, baselineCount: 10, baselineTotalCount: 70 })],
      config,
    );
    const surge = evaluateDataQualityCheck(
      'volume_anomalies',
      [observation({ count: 25, baselineCount: 10, baselineTotalCount: 70 })],
      config,
    );

    expect(collapse.status).toBe('fail');
    expect(surge.status).toBe('fail');
  });

  it('does not fail when the baseline is insufficient', () => {
    const result = evaluateDataQualityCheck(
      'volume_anomalies',
      [observation({ count: 1, baselineCount: 0, baselineTotalCount: 0 })],
      config,
    );

    expect(result.status).toBe('pass');
    expect(result.reason).toBe('baseline_insufficient');
  });

  it('returns a clean result without leaking samples', () => {
    const result = evaluateDataQualityCheck(
      'future_timestamps',
      [observation({ count: 0, samples: [{ table: 'jobs', key: 9 }] })],
      config,
    );

    expect(result.status).toBe('pass');
    expect(result.sampleKeys).toEqual([]);
  });
});

describe('formatDataQualitySample', () => {
  it('masks every identifier and bounds labels', () => {
    const formatted = formatDataQualitySample({
      table: 'jobs',
      key: 12345678901234,
      externalUserId: 'external-123456789',
      userId: 987654321,
      label: 'status=processing',
    });

    expect(formatted).toBe(
      'jobs;key=1234…1234;external=exte…6789;user=98…;status=processing',
    );
    expect(formatted).not.toContain('12345678901234');
    expect(formatted).not.toContain('external-123456789');
  });
});
