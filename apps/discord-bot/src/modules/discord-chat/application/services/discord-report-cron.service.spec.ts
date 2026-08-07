import { DiscordReportCronService } from './discord-report-cron.service';

const LINK = {
  id: '1',
  platform: 'discord',
  externalUserId: 'discord-1',
  userId: 10,
  linkedAt: new Date(),
};

const ZERO_RESULT = {
  sent: 0,
  skipped: 0,
  deferred: 0,
  windowClosed: 0,
  claimSkipped: 0,
  retryQueued: 0,
  failures: [],
};

describe('DiscordReportCronService', () => {
  const buildService = (overrides?: {
    leaderEnabled?: boolean;
    lockAcquired?: boolean;
    links?: unknown[];
    results?: unknown[];
    claimAndSendError?: Error;
  }) => {
    const reportCronLeaderService = {
      shouldRunScheduledReportCron: jest
        .fn()
        .mockReturnValue(overrides?.leaderEnabled ?? true),
    };

    const reportCronLockService = {
      tryAcquireDailyLock: jest
        .fn()
        .mockResolvedValue(overrides?.lockAcquired ?? true),
      releaseDailyLock: jest.fn().mockResolvedValue(undefined),
    };

    const orchestrationService = {
      claimAndSend: jest.fn().mockImplementation(() => {
        const next = overrides?.results?.shift();
        if (next !== undefined) {
          return Promise.resolve(next);
        }
        if (overrides?.claimAndSendError) {
          return Promise.reject(overrides.claimAndSendError);
        }
        return Promise.resolve(ZERO_RESULT);
      }),
    };

    const accountLinkRepo = {
      find: jest.fn().mockResolvedValue(overrides?.links ?? []),
    };

    const service = new DiscordReportCronService(
      { get: jest.fn().mockReturnValue(undefined) } as never,
      reportCronLeaderService as never,
      reportCronLockService as never,
      {} as never,
      orchestrationService as never,
      accountLinkRepo as never,
    );

    return {
      service,
      reportCronLeaderService,
      reportCronLockService,
      orchestrationService,
      accountLinkRepo,
    };
  };

  it('batches links with runBatched and aggregates sent/skipped', async () => {
    const { service, orchestrationService } = buildService({
      links: [LINK, { ...LINK, id: '2', externalUserId: 'discord-2' }],
      results: [
        { ...ZERO_RESULT, sent: 1 },
        { ...ZERO_RESULT, skipped: 1 },
      ],
    });

    const result = await service.sendScheduledReports();

    expect(result.total).toBe(2);
    expect(result.sent).toBe(1);
    expect(result.skipped).toBe(1);
    expect(orchestrationService.claimAndSend).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ externalUserId: 'discord-1' }),
      {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        reportDate: expect.any(String),
        skipAlreadySentToday: true,
      },
    );
    expect(orchestrationService.claimAndSend).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ externalUserId: 'discord-2' }),
      {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        reportDate: expect.any(String),
        skipAlreadySentToday: true,
      },
    );
  });

  it('aggregates claimSkipped and failed (including rejected results)', async () => {
    const { service, orchestrationService } = buildService({
      links: [LINK, { ...LINK, id: '2', externalUserId: 'discord-2' }],
      results: [
        {
          ...ZERO_RESULT,
          claimSkipped: 1,
          failures: [{ externalUserId: 'discord-1', error: 'claim lost' }],
        },
      ],
      claimAndSendError: new Error('boom'),
    });

    const result = await service.sendScheduledReports();

    expect(result.claimSkipped).toBe(1);
    expect(result.failed).toBe(2);
    expect(result.failures).toHaveLength(2);
    expect(orchestrationService.claimAndSend).toHaveBeenCalledTimes(2);
  });

  it('skips the whole run when not the cron leader', async () => {
    const { service, accountLinkRepo, reportCronLockService } = buildService({
      leaderEnabled: false,
    });

    await service.handleDailyReportCron();

    expect(accountLinkRepo.find).not.toHaveBeenCalled();
    expect(reportCronLockService.tryAcquireDailyLock).not.toHaveBeenCalled();
  });

  it('skips the whole run when the daily lock is not acquired, releases it after', async () => {
    const { service, accountLinkRepo, reportCronLockService } = buildService({
      lockAcquired: false,
    });

    await service.handleDailyReportCron();

    expect(accountLinkRepo.find).not.toHaveBeenCalled();
    expect(reportCronLockService.releaseDailyLock).not.toHaveBeenCalled();
  });

  it('releases the daily lock after a successful run', async () => {
    const { service, reportCronLockService, accountLinkRepo } = buildService();

    await service.handleDailyReportCron();

    expect(reportCronLockService.tryAcquireDailyLock).toHaveBeenCalled();
    expect(reportCronLockService.releaseDailyLock).toHaveBeenCalled();
    expect(accountLinkRepo.find).toHaveBeenCalledWith({
      where: { platform: 'discord' },
    });
  });
});
