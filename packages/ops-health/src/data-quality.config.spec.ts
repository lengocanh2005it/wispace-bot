import {
  DATA_QUALITY_DEFAULTS,
  isDataQualityCronEnabled,
  readDataQualityConfig,
} from './data-quality.config';

describe('data-quality config', () => {
  it('uses documented defaults', () => {
    expect(readDataQualityConfig(() => undefined)).toEqual(
      DATA_QUALITY_DEFAULTS,
    );
  });

  it('reads bounded overrides and rejects invalid values', () => {
    const values: Record<string, string> = {
      DATA_QUALITY_SAMPLE_LIMIT: '9',
      DATA_QUALITY_NULL_SPIKE_RATIO: '3',
      DATA_QUALITY_NULL_SPIKE_MIN_RATE_DELTA: '0.25',
      DATA_QUALITY_VOLUME_LOW_RATIO: '0.25',
      DATA_QUALITY_VOLUME_HIGH_RATIO: '-1',
      DATA_QUALITY_STATEMENT_TIMEOUT_MS: 'invalid',
    };
    const config = readDataQualityConfig((key) => values[key]);

    expect(config.sampleLimit).toBe(9);
    expect(config.nullSpikeRatio).toBe(3);
    expect(config.nullSpikeMinRateDelta).toBe(0.25);
    expect(config.volumeLowRatio).toBe(0.25);
    expect(config.volumeHighRatio).toBe(DATA_QUALITY_DEFAULTS.volumeHighRatio);
    expect(config.statementTimeoutMs).toBe(
      DATA_QUALITY_DEFAULTS.statementTimeoutMs,
    );
  });

  it('enables the cron by default only in production', () => {
    expect(isDataQualityCronEnabled(() => undefined, 'production')).toBe(true);
    expect(isDataQualityCronEnabled(() => undefined, 'development')).toBe(
      false,
    );
    expect(
      isDataQualityCronEnabled(
        (key) => (key === 'DATA_QUALITY_CRON_ENABLED' ? 'true' : undefined),
        'development',
      ),
    ).toBe(true);
  });
});
