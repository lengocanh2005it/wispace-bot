import { ReportCronService } from './report-cron.service';

describe('ReportCronService.sendScheduledReports (R5 ops)', () => {
  const mapping = {
    id: 1,
    psid: 'psid-1',
    userId: 10,
    notificationMessagesToken: 'tok-1',
    topic: 'ielts',
    cadence: 'weekly' as const,
    status: 'ACTIVE' as const,
  };

  const buildService = () => {
    const messengerRepository = {
      cleanupActiveDuplicateMappings: jest.fn().mockResolvedValue(0),
      findActiveSubscribedMappingsPage: jest
        .fn()
        .mockResolvedValueOnce([mapping])
        .mockResolvedValueOnce([]),
    };

    const reportScheduleService = {
      getExamReminderWindow: jest
        .fn()
        .mockReturnValue({ minDays: 2, maxDays: 3 }),
      shouldSendReportToday: jest.fn().mockResolvedValue({
        shouldSend: true,
        examDate: '2026-06-15',
        daysUntilExam: 2,
        minDays: 2,
        maxDays: 3,
      }),
    };

    const reportSendOrchestrationService = {
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

    const service = new ReportCronService(
      messengerRepository as never,
      reportScheduleService as never,
      {} as never,
      {} as never,
      { get: jest.fn().mockReturnValue(undefined) } as never,
      reportSendOrchestrationService as never,
    );

    return {
      service,
      messengerRepository,
      reportSendOrchestrationService,
    };
  };

  it('delegates to orchestration service for claim and send', async () => {
    const { service, reportSendOrchestrationService } = buildService();

    const result = await service.sendScheduledReports({
      forceSend: true,
      psid: 'psid-1',
    });

    expect(result.sent).toBe(1);
    expect(reportSendOrchestrationService.claimAndSend).toHaveBeenCalledWith(
      mapping,
      {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        reportDate: expect.any(String),
        skipAlreadySentToday: true,
        examDateForOutbox: '2026-06-15',
      },
    );
  });

  it('skips when exam window not met and not forceSend', async () => {
    const reportScheduleService = {
      getExamReminderWindow: jest
        .fn()
        .mockReturnValue({ minDays: 2, maxDays: 3 }),
      shouldSendReportToday: jest.fn().mockResolvedValue({
        shouldSend: false,
        examDate: '2026-06-15',
        daysUntilExam: 10,
        minDays: 2,
        maxDays: 3,
      }),
    };

    const reportSendOrchestrationService = {
      claimAndSend: jest.fn(),
    };

    const messengerRepository = {
      cleanupActiveDuplicateMappings: jest.fn().mockResolvedValue(0),
      findActiveSubscribedMappingsPage: jest
        .fn()
        .mockResolvedValueOnce([mapping])
        .mockResolvedValueOnce([]),
    };

    const service = new ReportCronService(
      messengerRepository as never,
      reportScheduleService as never,
      {} as never,
      {} as never,
      { get: jest.fn().mockReturnValue(undefined) } as never,
      reportSendOrchestrationService as never,
    );

    const result = await service.sendScheduledReports({ psid: 'psid-1' });

    expect(result.skipped).toBe(1);
    expect(result.sent).toBe(0);
    expect(reportSendOrchestrationService.claimAndSend).not.toHaveBeenCalled();
  });

  it('paginates mappings in bounded keyset pages', async () => {
    const mappings = Array.from({ length: 1200 }, (_, i) => ({
      ...mapping,
      id: i + 1,
      psid: `psid-${i + 1}`,
    }));

    const messengerRepository = {
      cleanupActiveDuplicateMappings: jest.fn().mockResolvedValue(0),
      findActiveSubscribedMappingsPage: jest
        .fn()
        .mockResolvedValueOnce(mappings.slice(0, 500))
        .mockResolvedValueOnce(mappings.slice(500, 1000))
        .mockResolvedValueOnce(mappings.slice(1000, 1200))
        .mockResolvedValueOnce([]),
    };

    const reportSendOrchestrationService = {
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

    const service = new ReportCronService(
      messengerRepository as never,
      {
        getExamReminderWindow: jest
          .fn()
          .mockReturnValue({ minDays: 2, maxDays: 3 }),
        shouldSendReportToday: jest
          .fn()
          .mockResolvedValue({ shouldSend: true }),
      } as never,
      {} as never,
      {} as never,
      { get: jest.fn().mockReturnValue(undefined) } as never,
      reportSendOrchestrationService as never,
    );

    const result = await service.sendScheduledReports({ forceSend: true });

    // Should have processed all 1200 mappings across 3 pages
    expect(result.total).toBe(1200);
    expect(reportSendOrchestrationService.claimAndSend).toHaveBeenCalledTimes(
      1200,
    );
    // Should have called the paginated method with cursor progression
    expect(
      messengerRepository.findActiveSubscribedMappingsPage,
    ).toHaveBeenCalledWith(0, 500);
    expect(
      messengerRepository.findActiveSubscribedMappingsPage,
    ).toHaveBeenCalledWith(500, 500);
    expect(
      messengerRepository.findActiveSubscribedMappingsPage,
    ).toHaveBeenCalledWith(1000, 500);
  });
  it('skips sending report when canonical platform for user is not messenger (e.g. zalo)', async () => {
    const messengerRepository = {
      findActiveSubscribedMappingsPage: jest
        .fn()
        .mockResolvedValue([
          { id: 1, psid: 'psid-1', userId: 42, cadence: 'daily' },
        ]),
    };
    const canonicalService = {
      getCanonicalPlatformForUser: jest.fn().mockResolvedValue('zalo'),
    };
    const reportSendOrchestrationService = {
      claimAndSend: jest.fn(),
    };
    const service = new ReportCronService(
      messengerRepository as never,
      {
        getExamReminderWindow: jest
          .fn()
          .mockReturnValue({ minDays: 2, maxDays: 3 }),
      } as never,
      {
        shouldRunScheduledReportCron: jest.fn().mockResolvedValue(true),
      } as never,
      {
        tryAcquireDailyLock: jest.fn().mockResolvedValue(true),
        releaseDailyLock: jest.fn(),
      } as never,
      { get: jest.fn() } as never,
      reportSendOrchestrationService as never,
      canonicalService as never,
    );

    const result = await service.sendScheduledReports({ forceSend: true });

    expect(canonicalService.getCanonicalPlatformForUser).toHaveBeenCalledWith(
      42,
    );
    expect(reportSendOrchestrationService.claimAndSend).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });
});
