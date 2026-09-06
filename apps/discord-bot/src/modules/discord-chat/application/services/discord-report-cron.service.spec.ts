/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Jest mock assertions */
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

const createPageMock = (pages: unknown[][]) => {
  const queryBuilder = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getMany: jest
      .fn()
      .mockImplementation(() => Promise.resolve(pages.shift() ?? [])),
  };
  return {
    findActiveAccountsPage: jest
      .fn()
      .mockImplementation((_cursor, limit) =>
        Promise.resolve(queryBuilder.take(limit).getMany()),
      ),
    createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    queryBuilder,
  };
};

describe('DiscordReportCronService', () => {
  const buildService = (overrides?: {
    leaderEnabled?: boolean;
    lockAcquired?: boolean;
    links?: unknown[];
    results?: unknown[];
    claimAndSendError?: Error;
    shouldSendReportToday?: jest.Mock;
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

    const reportScheduleService = {
      shouldSendReportToday:
        overrides?.shouldSendReportToday ??
        jest.fn().mockResolvedValue({
          shouldSend: true,
          daysUntilExam: 3,
          examDate: '2026-08-14',
          minDays: 2,
          maxDays: 3,
        }),
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

    const pageMock = createPageMock(
      overrides?.links?.length ? [overrides.links] : [],
    );

    const service = new DiscordReportCronService(
      { get: jest.fn().mockReturnValue(undefined) } as never,
      reportCronLeaderService as never,
      reportCronLockService as never,
      reportScheduleService as never,
      orchestrationService as never,
      pageMock,
    );

    return {
      service,
      reportCronLeaderService,
      reportCronLockService,
      reportScheduleService,
      orchestrationService,
      accountLinkRepo: pageMock,
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
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        reportDate: expect.any(String),
        skipAlreadySentToday: true,
        examDateForOutbox: '2026-08-14',
      }),
    );
    expect(orchestrationService.claimAndSend).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ externalUserId: 'discord-2' }),
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        reportDate: expect.any(String),
        skipAlreadySentToday: true,
        examDateForOutbox: '2026-08-14',
      }),
    );
  });

  it('pages accounts with keyset cursor and stops after a short page', async () => {
    const links = Array.from({ length: 250 }, (_, i) => ({
      ...LINK,
      id: String(i + 1),
      externalUserId: `discord-${i + 1}`,
    }));
    const pageMock = createPageMock([links.slice(0, 200), links.slice(200)]);
    const orchestrationService = {
      claimAndSend: jest.fn().mockResolvedValue(ZERO_RESULT),
    };
    const shouldSendReportToday = jest.fn().mockResolvedValue({
      shouldSend: true,
      daysUntilExam: 3,
      examDate: '2026-08-14',
      minDays: 2,
      maxDays: 3,
    });

    const service = new DiscordReportCronService(
      { get: jest.fn().mockReturnValue(undefined) } as never,
      { shouldRunScheduledReportCron: jest.fn() } as never,
      { tryAcquireDailyLock: jest.fn(), releaseDailyLock: jest.fn() } as never,
      { shouldSendReportToday } as never,
      orchestrationService as never,
      pageMock,
    );

    const result = await service.sendScheduledReports();

    expect(result.total).toBe(250);
    expect(orchestrationService.claimAndSend).toHaveBeenCalledTimes(250);
    expect(pageMock.findActiveAccountsPage).toHaveBeenCalledTimes(2);
    expect(pageMock.findActiveAccountsPage).toHaveBeenNthCalledWith(
      1,
      undefined,
      200,
      { includeUnsubscribed: false },
    );
    expect(pageMock.findActiveAccountsPage).toHaveBeenNthCalledWith(
      2,
      '200',
      200,
      { includeUnsubscribed: false },
    );
  });

  it('skips users outside the exam window without claiming', async () => {
    const { service, orchestrationService } = buildService({
      links: [LINK],
      shouldSendReportToday: jest.fn().mockResolvedValue({
        shouldSend: false,
        daysUntilExam: 30,
        examDate: '2026-09-10',
        minDays: 2,
        maxDays: 3,
      }),
    });

    const result = await service.sendScheduledReports();

    expect(result.skipped).toBe(1);
    expect(orchestrationService.claimAndSend).not.toHaveBeenCalled();
  });

  it('bypasses the window when forceSend is set', async () => {
    const { service, orchestrationService } = buildService({
      links: [LINK],
      shouldSendReportToday: jest.fn().mockResolvedValue({
        shouldSend: false,
        daysUntilExam: 30,
        examDate: '2026-09-10',
        minDays: 2,
        maxDays: 3,
      }),
      results: [{ ...ZERO_RESULT, sent: 1 }],
    });

    await service.sendScheduledReports({ forceSend: true });

    expect(orchestrationService.claimAndSend).toHaveBeenCalledWith(
      expect.objectContaining({ externalUserId: 'discord-1' }),
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        reportDate: expect.any(String),
        skipAlreadySentToday: true,
        allowUserIdLess: true,
        examDateForOutbox: '2026-09-10',
      }),
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

  it('caps reported failures at 50', async () => {
    const links = Array.from({ length: 3 }, (_, i) => ({
      ...LINK,
      id: String(i + 1),
      externalUserId: `discord-${i + 1}`,
    }));
    const orchestrationService = {
      claimAndSend: jest.fn().mockResolvedValue({
        ...ZERO_RESULT,
        failures: Array.from({ length: 40 }, (_, i) => ({
          externalUserId: `discord-${i + 1}`,
          error: `err-${i}`,
        })),
      }),
    };
    const shouldSendReportToday = jest.fn().mockResolvedValue({
      shouldSend: true,
      daysUntilExam: 3,
      examDate: '2026-08-14',
      minDays: 2,
      maxDays: 3,
    });

    const service = new DiscordReportCronService(
      { get: jest.fn().mockReturnValue(undefined) } as never,
      { shouldRunScheduledReportCron: jest.fn() } as never,
      { tryAcquireDailyLock: jest.fn(), releaseDailyLock: jest.fn() } as never,
      { shouldSendReportToday } as never,
      orchestrationService as never,
      createPageMock([links]),
    );

    const result = await service.sendScheduledReports();

    expect(result.failed).toBe(120);
    expect(result.failures).toHaveLength(51); // 50 + omission marker
  });

  it('skips the whole run when not the cron leader', async () => {
    const { service, accountLinkRepo, reportCronLockService } = buildService({
      leaderEnabled: false,
    });

    await service.handleDailyReportCron();

    expect(accountLinkRepo.createQueryBuilder).not.toHaveBeenCalled();
    expect(reportCronLockService.tryAcquireDailyLock).not.toHaveBeenCalled();
  });

  it('skips the whole run when the daily lock is not acquired, releases it after', async () => {
    const { service, accountLinkRepo, reportCronLockService } = buildService({
      lockAcquired: false,
    });

    await service.handleDailyReportCron();

    expect(accountLinkRepo.createQueryBuilder).not.toHaveBeenCalled();
    expect(reportCronLockService.releaseDailyLock).not.toHaveBeenCalled();
  });

  it('releases the daily lock after a successful run', async () => {
    const { service, reportCronLockService, accountLinkRepo } = buildService();

    await service.handleDailyReportCron();

    expect(reportCronLockService.tryAcquireDailyLock).toHaveBeenCalled();
    expect(reportCronLockService.releaseDailyLock).toHaveBeenCalled();
    expect(accountLinkRepo.findActiveAccountsPage).toHaveBeenCalledWith(
      undefined,
      200,
      { includeUnsubscribed: false },
    );
  });
  it('skips sending report when canonical platform for user is not discord (e.g. zalo)', async () => {
    const accountReader = {
      findActiveAccountsPage: jest
        .fn()
        .mockResolvedValue([{ id: '1', externalUserId: 'disc-1', userId: 42 }]),
    };
    const canonicalService = {
      isCanonicalForUser: jest
        .fn()
        .mockResolvedValue({ isCanonical: false, canonicalPlatform: 'zalo' }),
    };
    const orchestrationService = {
      claimAndSend: jest.fn(),
    };
    const service = new DiscordReportCronService(
      { get: jest.fn().mockReturnValue(undefined) } as never,
      { shouldRunScheduledReportCron: jest.fn() } as never,
      { tryAcquireDailyLock: jest.fn(), releaseDailyLock: jest.fn() } as never,
      {
        shouldSendReportToday: jest
          .fn()
          .mockResolvedValue({ shouldSend: true }),
      } as never,
      orchestrationService as never,
      accountReader as never,
      canonicalService as never,
    );

    const result = await service.sendScheduledReports();

    expect(canonicalService.isCanonicalForUser).toHaveBeenCalledWith(
      42,
      'discord',
    );
    expect(orchestrationService.claimAndSend).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });
  it('drops dormant links via partitionDormant and meters suppression by count', async () => {
    const links = [
      { id: '1', externalUserId: 'discord-1', userId: 10 },
      { id: '2', externalUserId: 'discord-2', userId: 20 },
    ];
    const accountReader = {
      findActiveAccountsPage: jest
        .fn()
        .mockResolvedValueOnce(links)
        .mockResolvedValueOnce([]),
    };
    const orchestrationService = {
      claimAndSend: jest.fn().mockResolvedValue({ ...ZERO_RESULT, sent: 1 }),
    };
    const webActivityService = {
      partitionDormant: jest
        .fn()
        .mockResolvedValue({ active: [links[0]], suppressed: 1 }),
    };
    const metrics = {
      incScheduledSendSuppressed: jest.fn(),
    };
    const service = new DiscordReportCronService(
      { get: jest.fn().mockReturnValue(undefined) } as never,
      { shouldRunScheduledReportCron: jest.fn() } as never,
      { tryAcquireDailyLock: jest.fn(), releaseDailyLock: jest.fn() } as never,
      {
        shouldSendReportToday: jest
          .fn()
          .mockResolvedValue({ shouldSend: true }),
      } as never,
      orchestrationService as never,
      accountReader as never,
      undefined,
      webActivityService as never,
      metrics as never,
    );

    const result = await service.sendScheduledReports();

    expect(webActivityService.partitionDormant).toHaveBeenCalledWith(
      links,
      expect.any(Function),
    );
    expect(orchestrationService.claimAndSend).toHaveBeenCalledTimes(1);
    expect(orchestrationService.claimAndSend).toHaveBeenCalledWith(
      expect.objectContaining({ externalUserId: 'discord-1' }),
      expect.anything(),
    );
    expect(metrics.incScheduledSendSuppressed).toHaveBeenCalledWith(
      'report',
      1,
    );
    expect(result.skipped).toBe(1);
  });

  it('does not consult the gate for an operator forceSend', async () => {
    const links = [{ id: '1', externalUserId: 'discord-1', userId: 10 }];
    const accountReader = {
      findActiveAccountsPage: jest
        .fn()
        .mockResolvedValueOnce(links)
        .mockResolvedValueOnce([]),
    };
    const orchestrationService = {
      claimAndSend: jest.fn().mockResolvedValue({ ...ZERO_RESULT, sent: 1 }),
    };
    const webActivityService = { partitionDormant: jest.fn() };
    const metrics = { incScheduledSendSuppressed: jest.fn() };
    const service = new DiscordReportCronService(
      { get: jest.fn().mockReturnValue(undefined) } as never,
      { shouldRunScheduledReportCron: jest.fn() } as never,
      { tryAcquireDailyLock: jest.fn(), releaseDailyLock: jest.fn() } as never,
      {
        shouldSendReportToday: jest
          .fn()
          .mockResolvedValue({ shouldSend: true }),
      } as never,
      orchestrationService as never,
      accountReader as never,
      undefined,
      webActivityService as never,
      metrics as never,
    );

    await service.sendScheduledReports({ forceSend: true });

    expect(webActivityService.partitionDormant).not.toHaveBeenCalled();
    expect(metrics.incScheduledSendSuppressed).not.toHaveBeenCalled();
  });
});
