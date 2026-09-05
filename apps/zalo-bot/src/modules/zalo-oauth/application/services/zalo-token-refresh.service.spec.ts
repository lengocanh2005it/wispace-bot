import type { ConfigService } from '@nestjs/config';
import type { SchedulerRegistry } from '@nestjs/schedule';
import { ZaloTokenRefreshService } from './zalo-token-refresh.service';
import { ZaloTokenService } from './zalo-token.service';

function buildConfig(): ConfigService {
  return {
    get: (key: string) => ({})[key],
  } as unknown as ConfigService;
}

function buildSchedulerRegistry(): SchedulerRegistry {
  return {
    addCronJob: jest.fn(),
  } as unknown as SchedulerRegistry;
}

describe('ZaloTokenRefreshService', () => {
  it('delegates to ZaloTokenService.refreshNow on the scheduled tick', async () => {
    const refreshNow = jest.fn().mockResolvedValue(undefined);
    const tokenService = { refreshNow } as unknown as ZaloTokenService;

    const service = new ZaloTokenRefreshService(
      tokenService,
      buildConfig(),
      buildSchedulerRegistry(),
    );
    await service.handleCron();

    expect(refreshNow).toHaveBeenCalledTimes(1);
  });

  it('registers and completes the cron heartbeat', async () => {
    const refreshNow = jest.fn().mockResolvedValue(undefined);
    const tokenService = { refreshNow } as unknown as ZaloTokenService;
    const metrics = {
      registerCron: jest.fn(),
      recordCronSuccess: jest.fn(),
    };
    const schedulerRegistry = buildSchedulerRegistry();
    const service = new ZaloTokenRefreshService(
      tokenService,
      buildConfig(),
      schedulerRegistry,
      metrics as never,
    );

    service.onModuleInit();
    await service.handleCron();

    expect(metrics.registerCron).toHaveBeenCalledWith(
      'zalo-oa-token-refresh',
      45 * 60 * 1000,
    );
    expect(metrics.recordCronSuccess).toHaveBeenCalledWith(
      'zalo-oa-token-refresh',
    );
  });

  it('uses the configured cron cadence for staleness detection', () => {
    const refreshNow = jest.fn().mockResolvedValue(undefined);
    const tokenService = { refreshNow } as unknown as ZaloTokenService;
    const metrics = { registerCron: jest.fn() };
    const schedulerRegistry = buildSchedulerRegistry();
    const config = {
      get: (key: string) =>
        key === 'ZALO_TOKEN_REFRESH_CRON' ? '*/15 * * * * *' : undefined,
    } as unknown as ConfigService;
    const service = new ZaloTokenRefreshService(
      tokenService,
      config,
      schedulerRegistry,
      metrics as never,
    );

    service.onModuleInit();

    expect(metrics.registerCron).toHaveBeenCalledWith(
      'zalo-oa-token-refresh',
      15_000,
    );
  });

  it('logs and swallows errors so one failed tick does not crash the cron', async () => {
    const refreshNow = jest.fn().mockRejectedValue(new Error('network down'));
    const tokenService = { refreshNow } as unknown as ZaloTokenService;

    const service = new ZaloTokenRefreshService(
      tokenService,
      buildConfig(),
      buildSchedulerRegistry(),
    );

    await expect(service.handleCron()).resolves.toBeUndefined();
  });
});
