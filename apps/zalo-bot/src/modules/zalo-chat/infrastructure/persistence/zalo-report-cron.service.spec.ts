import { Repository } from 'typeorm';
import {
  ReportClaimRepositoryPort,
  ReportScheduleService,
  todayReportDate,
} from '@wispace/scheduler-core';
import { ZaloAccountLinkEntity } from '@zalo/infrastructure/database/entities/zalo-account-link.entity';
import { ZaloReportCronService } from './zalo-report-cron.service';

jest.mock('@wispace/scheduler-core', () => ({
  ...jest.requireActual('@wispace/scheduler-core'),
  evaluateExamWindow: jest.fn().mockResolvedValue({ skip: false }),
  runBatched: jest.fn().mockImplementation(async (items, _concurrency, fn) => {
    const results = [];
    for (const item of items) {
      results.push({ status: 'fulfilled', value: await fn(item) });
    }
    return results;
  }),
}));

const reportDate = todayReportDate();
const link = {
  id: '1',
  externalUserId: 'zalo-1',
  userId: 42,
  platform: 'zalo',
} as unknown as ZaloAccountLinkEntity;

function buildService(overrides: {
  orchestrationClaimAndSend?: jest.Mock;
  listUserIdsWithSentReportToday?: jest.Mock;
  pages?: unknown[][];
  evaluateExamWindow?: { skip: boolean };
}) {
  const linkRepo = {
    createQueryBuilder: jest.fn(() => ({
      leftJoin: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest
        .fn()
        .mockImplementation(() =>
          Promise.resolve(overrides.pages?.shift() ?? [link]),
        ),
    })),
    update: jest.fn().mockResolvedValue(undefined),
  } as unknown as Repository<ZaloAccountLinkEntity>;

  const listUserIdsWithSentReportToday =
    overrides.listUserIdsWithSentReportToday ?? jest.fn().mockResolvedValue([]);

  const claimRepo = {
    listUserIdsWithSentReportToday,
    tryClaimScheduledReport: jest.fn(),
    markScheduledReportClaimSent: jest.fn(),
    releaseScheduledReportClaim: jest.fn(),
  } as unknown as ReportClaimRepositoryPort;

  const orchestrationClaimAndSend =
    overrides.orchestrationClaimAndSend ??
    jest.fn().mockResolvedValue({
      sent: 1,
      skipped: 0,
      deferred: 0,
      windowClosed: 0,
      claimSkipped: 0,
      retryQueued: 0,
      failures: [],
    });

  const orchestration = { claimAndSend: orchestrationClaimAndSend };

  const reportScheduleService = {} as ReportScheduleService;

  const service = new ZaloReportCronService(
    linkRepo,
    claimRepo,
    orchestration as never,
    { generateReport: jest.fn() } as never,
    reportScheduleService,
    { get: jest.fn() } as never,
  );

  return {
    service,
    listUserIdsWithSentReportToday,
    orchestrationClaimAndSend,
  };
}

describe('ZaloReportCronService', () => {
  it('pages accounts with keyset cursor and stops after a short page', async () => {
    const pageLinks = Array.from({ length: 250 }, (_, i) => ({
      id: String(i + 1),
      externalUserId: `zalo-${i + 1}`,
      userId: 42 + i,
      platform: 'zalo',
    })) as unknown as ZaloAccountLinkEntity[];

    const { service, orchestrationClaimAndSend } = buildService({
      pages: [pageLinks.slice(0, 200), pageLinks.slice(200)],
    });

    await service.sendDailyReports();

    expect(orchestrationClaimAndSend).toHaveBeenCalledTimes(250);
  });

  it('skips user already sent on another platform', async () => {
    const {
      service,
      listUserIdsWithSentReportToday,
      orchestrationClaimAndSend,
    } = buildService({
      listUserIdsWithSentReportToday: jest.fn().mockResolvedValue([42]),
    });

    await service.sendDailyReports();

    expect(listUserIdsWithSentReportToday).toHaveBeenCalledWith(reportDate);
    expect(orchestrationClaimAndSend).not.toHaveBeenCalled();
  });

  it('passes generateReport callback to orchestration', async () => {
    const { service, orchestrationClaimAndSend } = buildService({});

    await service.sendDailyReports();

    expect(orchestrationClaimAndSend).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: 'zalo',
        externalUserId: 'zalo-1',
        userId: 42,
      }),
      expect.objectContaining({
        reportDate,
        skipAlreadySentToday: true,
        reportText: '',
        classifyError: expect.any(Function),
        generateReport: expect.any(Function),
      }),
    );
  });

  it('forceSend bypasses exam window check', async () => {
    const { service, orchestrationClaimAndSend } = buildService({});

    await service.sendDailyReports({ forceSend: true });

    expect(orchestrationClaimAndSend).toHaveBeenCalled();
  });
  it('filters to report-opted-in learners (#596 AC2)', async () => {
    const andWhere = jest.fn().mockReturnThis();
    const leftJoin = jest.fn().mockReturnThis();
    const linkRepo = {
      createQueryBuilder: jest.fn().mockReturnValue({
        leftJoin,
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere,
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      }),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const claimRepo = {
      listUserIdsWithSentReportToday: jest.fn().mockResolvedValue([]),
    };

    const service = new ZaloReportCronService(
      linkRepo as unknown as never,
      claimRepo as unknown as never,
      { claimAndSend: jest.fn() } as unknown as never,
      { generateReport: jest.fn() } as unknown as never,
      {} as unknown as never,
      { get: jest.fn() } as unknown as never,
    );
    await service.sendDailyReports();

    expect(leftJoin).toHaveBeenCalledWith(
      'user_notification_preferences',
      'pref',
      'pref.user_id = link.user_id',
    );
    expect(andWhere).toHaveBeenCalledWith(
      'COALESCE(pref.report_enabled, false) = true',
    );
  });

  it('does not apply the report consent gate for an operator forceSend (#596)', async () => {
    const andWhere = jest.fn().mockReturnThis();
    const linkRepo = {
      createQueryBuilder: jest.fn().mockReturnValue({
        leftJoin: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere,
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      }),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const claimRepo = {
      listUserIdsWithSentReportToday: jest.fn().mockResolvedValue([]),
    };

    const service = new ZaloReportCronService(
      linkRepo as unknown as never,
      claimRepo as unknown as never,
      { claimAndSend: jest.fn() } as unknown as never,
      { generateReport: jest.fn() } as unknown as never,
      {} as unknown as never,
      { get: jest.fn() } as unknown as never,
    );
    await service.sendDailyReports({ forceSend: true });

    expect(andWhere).not.toHaveBeenCalledWith(
      'COALESCE(pref.report_enabled, false) = true',
    );
  });
  it('skips sending report when canonical platform for user is not zalo (e.g. preferred discord)', async () => {
    const linkRepo = {
      createQueryBuilder: jest.fn().mockReturnValue({
        leftJoin: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest
          .fn()
          .mockResolvedValue([
            { id: '1', externalUserId: 'zalo-1', userId: 42, platform: 'zalo' },
          ]),
      }),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const canonicalService = {
      isCanonicalForUser: jest.fn().mockResolvedValue({
        isCanonical: false,
        canonicalPlatform: 'discord',
      }),
    };
    const claimRepo = {
      listUserIdsWithSentReportToday: jest.fn().mockResolvedValue([]),
    };
    const orchestration = { claimAndSend: jest.fn() };
    const reportService = { generateReport: jest.fn() };
    const reportScheduleService = { getExamReminderWindow: jest.fn() };
    const configService = { get: jest.fn() };

    const service = new ZaloReportCronService(
      linkRepo as unknown as never,
      claimRepo as unknown as never,
      orchestration as unknown as never,
      reportService as unknown as never,
      reportScheduleService as unknown as never,
      configService as unknown as never,
      canonicalService as unknown as never,
    );

    await service.sendDailyReports({ forceSend: true });

    expect(canonicalService.isCanonicalForUser).toHaveBeenCalledWith(
      42,
      'zalo',
    );
    expect(reportService.generateReport).not.toHaveBeenCalled();
    expect(orchestration.claimAndSend).not.toHaveBeenCalled();
  });

  it('filters dormant links and increments suppression metric when gate is enabled', async () => {
    const links = [
      {
        id: '1',
        externalUserId: 'zalo-1',
        userId: 5,
        platform: 'zalo',
        linkState: 'active',
      },
      {
        id: '2',
        externalUserId: 'zalo-2',
        userId: 6,
        platform: 'zalo',
        linkState: 'active',
      },
    ];
    const linkRepo = {
      createQueryBuilder: jest.fn().mockReturnValue({
        leftJoin: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest
          .fn()
          .mockResolvedValueOnce(links)
          .mockResolvedValueOnce([]),
      }),
    };
    const claimRepo = {
      listUserIdsWithSentReportToday: jest.fn().mockResolvedValue([]),
    };
    const orchestration = {
      claimAndSend: jest.fn().mockResolvedValue({
        sent: 1,
        skipped: 0,
        deferred: 0,
        windowClosed: 0,
        claimSkipped: 0,
        retryQueued: 0,
        failures: [],
      }),
    };
    const reportService = { generateReport: jest.fn() };
    const reportScheduleService = {
      getExamReminderWindow: jest
        .fn()
        .mockReturnValue({ minDays: 1, maxDays: 30 }),
    };
    const configService = { get: jest.fn() };
    const webActivityService = {
      partitionDormant: jest
        .fn()
        .mockResolvedValue({ active: [links[1]], suppressed: 1 }),
    };
    const metrics = {
      incScheduledSendSuppressed: jest.fn(),
    };

    const service = new ZaloReportCronService(
      linkRepo as unknown as never,
      claimRepo as unknown as never,
      orchestration as unknown as never,
      reportService as unknown as never,
      reportScheduleService as unknown as never,
      configService as unknown as never,
      undefined,
      webActivityService as never,
      metrics as never,
    );

    const sendReportForUserSpy = jest
      .spyOn(service as any, 'sendReportForUser')
      .mockResolvedValue('sent');

    await service.sendDailyReports();

    expect(webActivityService.partitionDormant).toHaveBeenCalledWith(
      links,
      expect.any(Function),
    );
    expect(sendReportForUserSpy).toHaveBeenCalledTimes(1);
    expect(sendReportForUserSpy).toHaveBeenCalledWith(
      expect.objectContaining({ externalUserId: 'zalo-2', userId: 6 }),
      expect.anything(),
      expect.anything(),
      false,
    );
    expect(metrics.incScheduledSendSuppressed).toHaveBeenCalledWith(
      'report',
      1,
    );
  });

  it('does not consult the gate for an operator forceSend', async () => {
    const links = [
      {
        id: '1',
        externalUserId: 'zalo-1',
        userId: 5,
        platform: 'zalo',
        linkState: 'active',
      },
    ];
    const linkRepo = {
      createQueryBuilder: jest.fn().mockReturnValue({
        leftJoin: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest
          .fn()
          .mockResolvedValueOnce(links)
          .mockResolvedValueOnce([]),
      }),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const claimRepo = {
      listUserIdsWithSentReportToday: jest.fn().mockResolvedValue([]),
    };
    const orchestration = {
      claimAndSend: jest.fn().mockResolvedValue({
        sent: 1,
        skipped: 0,
        deferred: 0,
        windowClosed: 0,
        claimSkipped: 0,
        retryQueued: 0,
        failures: [],
      }),
    };
    const reportService = { generateReport: jest.fn() };
    const reportScheduleService = {
      getExamReminderWindow: jest
        .fn()
        .mockReturnValue({ minDays: 1, maxDays: 30 }),
    };
    const configService = { get: jest.fn() };
    const webActivityService = { partitionDormant: jest.fn() };
    const metrics = {
      incScheduledSendSuppressed: jest.fn(),
    };

    const service = new ZaloReportCronService(
      linkRepo as unknown as never,
      claimRepo as unknown as never,
      orchestration as unknown as never,
      reportService as unknown as never,
      reportScheduleService as unknown as never,
      configService as unknown as never,
      undefined,
      webActivityService as never,
      metrics as never,
    );

    jest.spyOn(service as any, 'sendReportForUser').mockResolvedValue('sent');

    await service.sendDailyReports({ forceSend: true });

    expect(webActivityService.partitionDormant).not.toHaveBeenCalled();
    expect(metrics.incScheduledSendSuppressed).not.toHaveBeenCalled();
  });
});
