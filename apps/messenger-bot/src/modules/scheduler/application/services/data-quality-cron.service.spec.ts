import { ConfigService } from '@nestjs/config';
import { DataQualityCronService } from './data-quality-cron.service';
import type { DataQualityRunResult } from '@wispace/ops-health';

function config(values: Record<string, string> = {}): ConfigService {
  return {
    get: (key: string) => values[key],
  } as unknown as ConfigService;
}

function result(
  overrides: Partial<DataQualityRunResult> = {},
): DataQualityRunResult {
  return {
    generatedAt: '2026-08-31T02:15:00.000Z',
    status: 'pass',
    durationMs: 42,
    lock: 'acquired',
    checks: [
      {
        check: 'null_spike',
        status: 'pass',
        count: 0,
        baseline: 0,
        threshold: 10,
        sampleKeys: [],
      },
    ],
    ...overrides,
  };
}

describe('DataQualityCronService', () => {
  it('skips when disabled', async () => {
    const dataQualityService = { run: jest.fn() };
    const service = new DataQualityCronService(
      dataQualityService as never,
      config({ DATA_QUALITY_CRON_ENABLED: 'false' }),
    );

    await service.handleDailyDataQualityCron();

    expect(dataQualityService.run).not.toHaveBeenCalled();
  });

  it('logs a clean run and executes the shared runner', async () => {
    const dataQualityService = { run: jest.fn().mockResolvedValue(result()) };
    const service = new DataQualityCronService(
      dataQualityService as never,
      config({ DATA_QUALITY_CRON_ENABLED: 'true' }),
    );

    await expect(service.handleDailyDataQualityCron()).resolves.toBeUndefined();
    expect(dataQualityService.run).toHaveBeenCalledTimes(1);
  });

  it('handles lock skip and failed checks without throwing', async () => {
    const dataQualityService = {
      run: jest.fn().mockResolvedValue(
        result({
          status: 'fail',
          checks: [
            {
              check: 'null_spike',
              status: 'fail',
              count: 20,
              baseline: 4,
              threshold: 10,
              reason: 'threshold_exceeded',
              sampleKeys: ['chat_daily_usage;key=1234…1234'],
            },
          ],
        }),
      ),
    };
    const service = new DataQualityCronService(
      dataQualityService as never,
      config({ DATA_QUALITY_CRON_ENABLED: 'true' }),
    );

    await expect(service.handleDailyDataQualityCron()).resolves.toBeUndefined();
    expect(dataQualityService.run).toHaveBeenCalledTimes(1);

    dataQualityService.run.mockResolvedValue(
      result({ status: 'skipped', lock: 'skipped', checks: [] }),
    );
    await expect(service.handleDailyDataQualityCron()).resolves.toBeUndefined();
  });
});
