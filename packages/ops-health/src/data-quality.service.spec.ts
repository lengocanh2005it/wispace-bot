import { DATA_QUALITY_DEFAULTS } from './data-quality.config';
import {
  buildDataQualityQueryWindow,
  DataQualityService,
} from './data-quality.service';
import type {
  DataQualityConfig,
  DataQualityMetricsPort,
  DataQualityRepositoryPort,
} from './data-quality.types';

const config: DataQualityConfig = { ...DATA_QUALITY_DEFAULTS };

function buildRepository(
  overrides: Partial<DataQualityRepositoryPort> = {},
): DataQualityRepositoryPort {
  return {
    getNullSpikeObservations: jest.fn().mockResolvedValue([]),
    getFutureTimestampObservations: jest.fn().mockResolvedValue([]),
    getTerminalTimestampObservations: jest.fn().mockResolvedValue([]),
    getStuckStateObservations: jest.fn().mockResolvedValue([]),
    getOrphanGrowthObservations: jest.fn().mockResolvedValue([]),
    getVolumeObservations: jest.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function buildMetrics(): DataQualityMetricsPort {
  return {
    setCheckStatus: jest.fn(),
    incRun: jest.fn(),
    incFailure: jest.fn(),
  };
}

describe('DataQualityService', () => {
  it('runs every anomaly class under the advisory lock and records metrics', async () => {
    const repository = buildRepository({
      getNullSpikeObservations: jest.fn().mockResolvedValue([
        {
          scope: 'chat_daily_usage',
          count: 20,
          baselineCount: 4,
          totalCount: 100,
          baselineTotalCount: 100,
          samples: [{ table: 'chat_daily_usage', key: 12345678901234 }],
        },
      ]),
      getFutureTimestampObservations: jest
        .fn()
        .mockResolvedValue([
          { scope: 'study_reminder_jobs.created_at', count: 1 },
        ]),
      getTerminalTimestampObservations: jest
        .fn()
        .mockResolvedValue([{ scope: 'report_send_jobs.sent_at', count: 1 }]),
      getStuckStateObservations: jest
        .fn()
        .mockResolvedValue([{ scope: 'chat_idempotency.reserved', count: 1 }]),
      getOrphanGrowthObservations: jest.fn().mockResolvedValue([
        {
          scope: 'study_reminder_jobs.user_id',
          count: 1,
          baselineCount: 0,
          baselineTotalCount: 20,
        },
      ]),
      getVolumeObservations: jest.fn().mockResolvedValue([
        {
          scope: 'webhook_inbound_events',
          count: 1,
          baselineCount: 10,
          baselineTotalCount: 70,
        },
      ]),
    });
    const lock = {
      withLock: jest.fn(async (_id: number, fn: () => Promise<unknown>) =>
        fn(),
      ),
    };
    const metrics = buildMetrics();
    const service = new DataQualityService(repository, lock, config, metrics);

    const result = await service.run(new Date('2026-08-31T02:15:00.000Z'));

    expect(result.status).toBe('fail');
    expect(result.lock).toBe('acquired');
    expect(result.checks).toHaveLength(6);
    expect(
      result.checks.filter((check) => check.status === 'fail'),
    ).toHaveLength(6);
    expect(
      result.checks.find((check) => check.check === 'null_spike')
        ?.sampleKeys[0],
    ).toBe('chat_daily_usage;key=1234…1234');
    expect(lock.withLock).toHaveBeenCalledWith(
      config.lockId,
      expect.any(Function),
    );
    expect(metrics.incRun).toHaveBeenCalledWith('fail');
    expect(metrics.incFailure).toHaveBeenCalledTimes(6);
  });

  it('skips without querying when another instance holds the lock', async () => {
    const repository = buildRepository();
    const lock = {
      withLock: jest.fn().mockResolvedValue(null),
    };
    const metrics = buildMetrics();
    const service = new DataQualityService(repository, lock, config, metrics);

    const result = await service.run();

    expect(result.status).toBe('skipped');
    expect(result.lock).toBe('skipped');
    expect(result.checks).toEqual([]);
    expect(repository.getNullSpikeObservations).not.toHaveBeenCalled();
    expect(metrics.incRun).toHaveBeenCalledWith('skipped');
  });

  it('turns one query failure into a visible failed check and continues', async () => {
    const repository = buildRepository({
      getFutureTimestampObservations: jest
        .fn()
        .mockRejectedValue(new Error('database unavailable')),
      getTerminalTimestampObservations: jest
        .fn()
        .mockResolvedValue([{ scope: 'inbox.processed_at', count: 1 }]),
    });
    const lock = {
      withLock: jest.fn(async (_id: number, fn: () => Promise<unknown>) =>
        fn(),
      ),
    };
    const service = new DataQualityService(repository, lock, config);

    const result = await service.run();

    expect(result.status).toBe('fail');
    expect(
      result.checks.find((check) => check.check === 'future_timestamps'),
    ).toMatchObject({
      status: 'fail',
      reason: 'query_error',
    });
    expect(
      result.checks.find((check) => check.check === 'terminal_timestamps'),
    ).toMatchObject({
      status: 'fail',
      reason: 'threshold_exceeded',
    });
  });

  it('records an infrastructure failure when lock acquisition fails', async () => {
    const metrics = buildMetrics();
    const lock = {
      withLock: jest.fn().mockRejectedValue(new Error('database unavailable')),
    };
    const service = new DataQualityService(
      buildRepository(),
      lock,
      config,
      metrics,
    );

    await expect(service.run()).rejects.toThrow('data_quality_run_failed');
    expect(metrics.incRun).toHaveBeenCalledWith('fail');
  });
});

describe('buildDataQualityQueryWindow', () => {
  it('uses complete ICT days and a bounded trailing baseline', () => {
    const window = buildDataQualityQueryWindow(
      new Date('2026-08-31T02:15:00.000Z'),
      config,
    );

    expect(window.currentStart.toISOString()).toBe('2026-08-29T17:00:00.000Z');
    expect(window.currentEnd.toISOString()).toBe('2026-08-30T17:00:00.000Z');
    expect(window.baselineStart.toISOString()).toBe('2026-08-22T17:00:00.000Z');
    expect(window.baselineEnd.toISOString()).toBe('2026-08-29T17:00:00.000Z');
  });
});
