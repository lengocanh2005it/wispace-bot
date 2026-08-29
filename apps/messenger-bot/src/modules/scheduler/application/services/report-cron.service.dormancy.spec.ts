import { ReportCronService } from './report-cron.service';

describe('ReportCronService dormancy gate', () => {
  it('filters out dormant mappings and meters suppression when gate is enabled', async () => {
    const mappings = [
      {
        id: 1,
        psid: 'p-1',
        userId: 1,
        notificationMessagesToken: 't1',
        topic: 'ielts',
        cadence: 'weekly' as const,
        status: 'ACTIVE' as const,
      },
      {
        id: 2,
        psid: 'p-2',
        userId: 2,
        notificationMessagesToken: 't2',
        topic: 'ielts',
        cadence: 'weekly' as const,
        status: 'ACTIVE' as const,
      },
    ];

    const messengerRepository = {
      cleanupActiveDuplicateMappings: jest.fn().mockResolvedValue(0),
      findActiveSubscribedMappingsPage: jest
        .fn()
        .mockResolvedValueOnce(mappings)
        .mockResolvedValueOnce([]),
    };

    const reportScheduleService = {
      getExamReminderWindow: jest
        .fn()
        .mockReturnValue({ minDays: 1, maxDays: 30 }),
      shouldSendReportToday: jest.fn().mockResolvedValue({ shouldSend: true }),
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

    const webActivityService = {
      gateEnabled: true,
      filterDormant: jest.fn().mockResolvedValue([2]),
    };

    const metrics = {
      incScheduledSendSuppressed: jest.fn(),
    };

    const service = new ReportCronService(
      messengerRepository as never,
      reportScheduleService as never,
      {} as never,
      {} as never,
      { get: jest.fn().mockReturnValue(undefined) } as never,
      reportSendOrchestrationService as never,
      undefined,
      webActivityService as never,
      metrics as never,
    );

    const result = await service.sendScheduledReports();

    expect(webActivityService.filterDormant).toHaveBeenCalledWith([1, 2]);
    expect(metrics.incScheduledSendSuppressed).toHaveBeenCalledWith('report');
    expect(metrics.incScheduledSendSuppressed).toHaveBeenCalledTimes(1);
    expect(reportSendOrchestrationService.claimAndSend).toHaveBeenCalledTimes(
      1,
    );
    expect(result.skipped).toBe(1);
  });

  it('does not call filterDormant when gate is disabled', async () => {
    const mappings = [
      {
        id: 1,
        psid: 'p-1',
        userId: 1,
        notificationMessagesToken: 't1',
        topic: 'ielts',
        cadence: 'weekly' as const,
        status: 'ACTIVE' as const,
      },
    ];

    const messengerRepository = {
      cleanupActiveDuplicateMappings: jest.fn().mockResolvedValue(0),
      findActiveSubscribedMappingsPage: jest
        .fn()
        .mockResolvedValueOnce(mappings)
        .mockResolvedValueOnce([]),
    };

    const reportScheduleService = {
      getExamReminderWindow: jest
        .fn()
        .mockReturnValue({ minDays: 1, maxDays: 30 }),
      shouldSendReportToday: jest.fn().mockResolvedValue({ shouldSend: true }),
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

    const webActivityService = {
      gateEnabled: false,
      filterDormant: jest.fn(),
    };

    const metrics = {
      incScheduledSendSuppressed: jest.fn(),
    };

    const service = new ReportCronService(
      messengerRepository as never,
      reportScheduleService as never,
      {} as never,
      {} as never,
      { get: jest.fn().mockReturnValue(undefined) } as never,
      reportSendOrchestrationService as never,
      undefined,
      webActivityService as never,
      metrics as never,
    );

    await service.sendScheduledReports();

    expect(webActivityService.filterDormant).not.toHaveBeenCalled();
    expect(metrics.incScheduledSendSuppressed).not.toHaveBeenCalled();
  });
});
