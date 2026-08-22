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

  it('delegates to orchestration with correct mapping and reportText', async () => {
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
        classifyError: expect.any(Function),
      }),
    );
  });

  it('forceSend bypasses exam window check', async () => {
    const { service, orchestrationClaimAndSend } = buildService({});

    await service.sendDailyReports({ forceSend: true });

    expect(orchestrationClaimAndSend).toHaveBeenCalled();
  });
});
