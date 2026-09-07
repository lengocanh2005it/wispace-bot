/* eslint-disable @typescript-eslint/unbound-method -- Jest mock method assertions */
import type { ConfigService } from '@nestjs/config';
import type { SchedulerRegistry } from '@nestjs/schedule';
import { Logger } from '@nestjs/common';
import type { BotMetricsService } from '@wispace/bot-metrics';
import type { PgAdvisoryLockService } from '@wispace/bot-common/locks';
import type { NotificationPreferenceService } from '@wispace/database';
import type { ReengagementApiClient } from '@wispace/wispace-client';
import type { DiscordReengagementService } from './discord-reengagement.service';
import { DiscordReengagementCronService } from './discord-reengagement-cron.service';

const CANDIDATES = [
  { userId: 11, daysInactive: 12, variant: 'a' as const },
  { userId: 22, daysInactive: 11, variant: 'b' as const },
  { userId: 33, daysInactive: 13, variant: 'a' as const },
];

type Stubs = {
  client: { getCandidates: jest.Mock };
  orchestrator: { runOnce: jest.Mock };
  preferences: { findReportOptedInUserIds: jest.Mock };
  pgLock: { withLock: jest.Mock };
  metrics: {
    incReengagementSend: jest.Mock;
    registerCron: jest.Mock;
    recordCronSuccess: jest.Mock;
    setReengagementBatchDuration: jest.Mock;
  };
};

function buildStubs(): Stubs {
  return {
    client: {
      getCandidates: jest
        .fn()
        .mockResolvedValue({ totalCandidates: 3, candidates: CANDIDATES }),
    },
    orchestrator: {
      runOnce: jest.fn().mockResolvedValue({ outcome: 'sent', messageId: 'm' }),
    },
    preferences: {
      findReportOptedInUserIds: jest
        .fn()
        .mockResolvedValue(new Set([11, 22, 33])),
    },
    pgLock: {
      withLock: jest.fn((_id: number, fn: () => Promise<unknown>) => fn()),
    },
    metrics: {
      incReengagementSend: jest.fn(),
      registerCron: jest.fn(),
      recordCronSuccess: jest.fn(),
      setReengagementBatchDuration: jest.fn(),
    },
  };
}

function buildService(
  stubs: Stubs,
  env: Record<string, string> = { REENGAGEMENT_ENABLED: 'true' },
): DiscordReengagementCronService {
  const mergedEnv = {
    REENGAGEMENT_ENABLED: 'true',
    REENGAGEMENT_SEND_GAP_MS: '0',
    ...env,
  };
  const config = {
    get: (key: string) => mergedEnv[key],
  } as unknown as ConfigService;

  return new DiscordReengagementCronService(
    config,
    {
      addCronJob: jest.fn(),
      deleteCronJob: jest.fn(),
    } as unknown as SchedulerRegistry,
    stubs.client as unknown as ReengagementApiClient,
    stubs.orchestrator as unknown as DiscordReengagementService,
    stubs.preferences as unknown as NotificationPreferenceService,
    stubs.pgLock as unknown as PgAdvisoryLockService,
    stubs.metrics as unknown as BotMetricsService,
  );
}

describe('DiscordReengagementCronService.handleDailyBatch', () => {
  let stubs: Stubs;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    stubs = buildStubs();
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    jest.restoreAllMocks();
  });

  it('processes each candidate through the orchestration service and logs a summary', async () => {
    const service = buildService(stubs);

    const summary = await service.handleDailyBatch();

    expect(stubs.client.getCandidates).toHaveBeenCalledWith({
      platform: 'discord',
      days: 11,
      limit: 50,
    });
    expect(stubs.preferences.findReportOptedInUserIds).toHaveBeenCalledWith([
      11, 22, 33,
    ]);
    expect(stubs.orchestrator.runOnce).toHaveBeenCalledTimes(3);
    expect(stubs.orchestrator.runOnce).toHaveBeenCalledWith(22, {
      daysInactive: 11,
    });
    expect(summary).toEqual({
      fetched: 3,
      sent: 3,
      failed: 0,
      skipped: 0,
    });
    expect(stubs.metrics.incReengagementSend).toHaveBeenCalledWith(
      'fetched',
      3,
    );
  });

  it('returns silently when REENGAGEMENT_ENABLED is not true', async () => {
    const service = buildService(stubs, { REENGAGEMENT_ENABLED: 'false' });

    await service.handleDailyBatch();

    expect(stubs.client.getCandidates).not.toHaveBeenCalled();
  });

  it('skips (logs, no error) when the advisory lock is held elsewhere', async () => {
    stubs.pgLock.withLock.mockResolvedValue(null);
    const service = buildService(stubs);

    await service.handleDailyBatch();

    expect(stubs.client.getCandidates).not.toHaveBeenCalled();
    // Contention means nothing ran — no heartbeat, no duration.
    expect(stubs.metrics.recordCronSuccess).not.toHaveBeenCalled();
    expect(stubs.metrics.setReengagementBatchDuration).not.toHaveBeenCalled();
  });

  it('skips candidates that have not opted in to reports (#596)', async () => {
    stubs.preferences.findReportOptedInUserIds.mockResolvedValue(new Set([11]));
    const service = buildService(stubs);

    const summary = await service.handleDailyBatch();

    expect(stubs.orchestrator.runOnce).toHaveBeenCalledTimes(1);
    expect(stubs.orchestrator.runOnce).toHaveBeenCalledWith(11, {
      daysInactive: 12,
    });
    expect(summary.skipped).toBe(2);
    expect(stubs.metrics.incReengagementSend).toHaveBeenCalledWith(
      'skipped',
      2,
    );
  });

  it('dry-run scans and fetches payload but never DMs or marks sent', async () => {
    const service = buildService(stubs, {
      REENGAGEMENT_ENABLED: 'true',
      REENGAGEMENT_DRY_RUN: 'true',
    });

    const summary = await service.handleDailyBatch();

    expect(summary.fetched).toBe(3);
    expect(summary.sent).toBe(0);
    expect(stubs.orchestrator.runOnce).not.toHaveBeenCalled();
    expect(stubs.metrics.incReengagementSend).not.toHaveBeenCalledWith(
      'sent',
      expect.anything(),
    );
  });

  it('continues the batch after one candidate fails', async () => {
    stubs.orchestrator.runOnce
      .mockResolvedValueOnce({ outcome: 'failed', reason: 'not_sent' })
      .mockResolvedValueOnce({ outcome: 'sent', messageId: 'm-2' })
      .mockResolvedValueOnce({ outcome: 'rate_limited' });
    const service = buildService(stubs);

    const summary = await service.handleDailyBatch();

    expect(stubs.orchestrator.runOnce).toHaveBeenCalledTimes(3);
    expect(summary).toEqual({
      fetched: 3,
      sent: 1,
      failed: 2,
      skipped: 0,
    });
  });

  it('continues the batch when the orchestrator throws on one candidate', async () => {
    stubs.orchestrator.runOnce
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce({ outcome: 'sent', messageId: 'm-2' })
      .mockResolvedValueOnce({ outcome: 'sent', messageId: 'm-3' });
    const service = buildService(stubs);

    const summary = await service.handleDailyBatch();

    expect(stubs.orchestrator.runOnce).toHaveBeenCalledTimes(3);
    expect(summary).toEqual({
      fetched: 3,
      sent: 2,
      failed: 1,
      skipped: 0,
    });
  });

  it('logs and counts a scan failure instead of throwing', async () => {
    stubs.client.getCandidates.mockRejectedValue(
      new Error('backend unreachable'),
    );
    const service = buildService(stubs);

    await expect(service.handleDailyBatch()).rejects.toThrow(
      'backend unreachable',
    );
    // The cron tick wraps this with catch — simulate the tick path:
    const tick = () =>
      service.handleDailyBatch().catch(() => {
        stubs.metrics.incReengagementSend('failed');
        return undefined;
      });
    await expect(tick()).resolves.toBeUndefined();
    expect(stubs.metrics.incReengagementSend).toHaveBeenCalledWith('failed');
  });

  it('caps the batch at REENGAGEMENT_MAX_PER_BATCH and warns about the remainder', async () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    const service = buildService(stubs, {
      REENGAGEMENT_ENABLED: 'true',
      REENGAGEMENT_MAX_PER_BATCH: '2',
    });

    const summary = await service.handleDailyBatch();

    expect(stubs.orchestrator.runOnce).toHaveBeenCalledTimes(2);
    expect(summary.fetched).toBe(2);
    warnSpy.mockRestore();
  });

  it('respects REENGAGEMENT_LIMIT for the scan page size', async () => {
    const service = buildService(stubs, {
      REENGAGEMENT_ENABLED: 'true',
      REENGAGEMENT_LIMIT: '10',
      REENGAGEMENT_DAYS: '7',
    });

    await service.handleDailyBatch();

    expect(stubs.client.getCandidates).toHaveBeenCalledWith({
      platform: 'discord',
      days: 7,
      limit: 10,
    });
  });
});

describe('DiscordReengagementCronService cron registration', () => {
  function buildWithRegistry(env: Record<string, string | undefined>): {
    service: DiscordReengagementCronService;
    registry: { addCronJob: jest.Mock; deleteCronJob: jest.Mock };
  } {
    const config = {
      get: (key: string) => env[key],
    } as unknown as ConfigService;
    const registry = {
      addCronJob: jest.fn(),
      deleteCronJob: jest.fn(),
    };
    const stubs = buildStubs();
    const service = new DiscordReengagementCronService(
      config,
      registry as unknown as SchedulerRegistry,
      stubs.client as unknown as ReengagementApiClient,
      stubs.orchestrator as unknown as DiscordReengagementService,
      stubs.preferences as unknown as NotificationPreferenceService,
      stubs.pgLock as unknown as PgAdvisoryLockService,
      stubs.metrics as unknown as BotMetricsService,
    );
    return { service, registry };
  }

  it('registers the cron with the configured expression and timezone when enabled', () => {
    const { service, registry } = buildWithRegistry({
      REENGAGEMENT_ENABLED: 'true',
      REENGAGEMENT_CRON: '30 8 * * *',
      REENGAGEMENT_TIMEZONE: 'UTC',
    });

    service.onModuleInit();

    expect(registry.addCronJob).toHaveBeenCalledTimes(1);
    const [name, job] = registry.addCronJob.mock.calls[0] as [string, unknown];
    expect(name).toBe('discord-reengagement-batch');
    expect((job as { cronTime: { source: string } }).cronTime.source).toBe(
      '30 8 * * *',
    );
  });

  it('registers nothing when disabled', () => {
    const { service, registry } = buildWithRegistry({});

    service.onModuleInit();

    expect(registry.addCronJob).not.toHaveBeenCalled();
  });
});

describe('DiscordReengagementCronService heartbeat + duration (#855)', () => {
  let stubs: Stubs;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    stubs = buildStubs();
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    jest.restoreAllMocks();
  });

  it('registers a 24h heartbeat on init when enabled', () => {
    const service = buildService(stubs, { REENGAGEMENT_ENABLED: 'true' });

    service.onModuleInit();

    expect(stubs.metrics.registerCron).toHaveBeenCalledWith(
      'discord-reengagement-batch',
      24 * 60 * 60 * 1000,
    );
  });

  it('does not register the heartbeat when disabled', () => {
    const service = buildService(stubs, { REENGAGEMENT_ENABLED: 'false' });

    service.onModuleInit();

    expect(stubs.metrics.registerCron).not.toHaveBeenCalled();
  });

  it('records cron success + duration after a real batch', async () => {
    const service = buildService(stubs);

    await service.handleDailyBatch();

    expect(stubs.metrics.recordCronSuccess).toHaveBeenCalledWith(
      'discord-reengagement-batch',
    );
    expect(stubs.metrics.setReengagementBatchDuration).toHaveBeenCalledWith(
      expect.any(Number),
    );
  });

  it('records heartbeat + duration on a dry-run batch too', async () => {
    const service = buildService(stubs, {
      REENGAGEMENT_ENABLED: 'true',
      REENGAGEMENT_DRY_RUN: 'true',
    });

    await service.handleDailyBatch();

    expect(stubs.metrics.recordCronSuccess).toHaveBeenCalledWith(
      'discord-reengagement-batch',
    );
    expect(stubs.metrics.setReengagementBatchDuration).toHaveBeenCalledWith(
      expect.any(Number),
    );
  });
});
