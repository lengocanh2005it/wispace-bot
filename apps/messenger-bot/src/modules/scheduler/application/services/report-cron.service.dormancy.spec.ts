import { ReportCronService } from './report-cron.service';

type Mapping = {
  id: number;
  psid: string;
  userId: number;
  notificationMessagesToken: string;
  topic: string;
  cadence: 'weekly';
  status: 'ACTIVE';
};

function mapping(id: number, userId: number): Mapping {
  return {
    id,
    psid: `p-${id}`,
    userId,
    notificationMessagesToken: `t${id}`,
    topic: 'ielts',
    cadence: 'weekly',
    status: 'ACTIVE',
  };
}

function buildService(overrides: {
  mappings: Mapping[];
  webActivityService?: unknown;
  metrics?: unknown;
  claimAndSend?: jest.Mock;
}): {
  service: ReportCronService;
  claimAndSend: jest.Mock;
} {
  const messengerRepository = {
    cleanupActiveDuplicateMappings: jest.fn().mockResolvedValue(0),
    findActiveSubscribedMappingsPage: jest
      .fn()
      .mockResolvedValueOnce(overrides.mappings)
      .mockResolvedValueOnce([]),
  };
  const reportScheduleService = {
    getExamReminderWindow: jest
      .fn()
      .mockReturnValue({ minDays: 1, maxDays: 30 }),
    shouldSendReportToday: jest.fn().mockResolvedValue({ shouldSend: true }),
  };
  const claimAndSend =
    overrides.claimAndSend ??
    jest.fn().mockResolvedValue({
      sent: 1,
      skipped: 0,
      deferred: 0,
      windowClosed: 0,
      claimSkipped: 0,
      retryQueued: 0,
      failures: [],
    });

  const service = new ReportCronService(
    messengerRepository as never,
    reportScheduleService as never,
    {} as never,
    {} as never,
    { get: jest.fn().mockReturnValue(undefined) } as never,
    { claimAndSend } as never,
    undefined,
    overrides.webActivityService as never,
    overrides.metrics as never,
  );
  return { service, claimAndSend };
}

describe('ReportCronService dormancy gate', () => {
  it('drops dormant mappings via partitionDormant and meters suppression by count', async () => {
    const mappings = [mapping(1, 1), mapping(2, 2)];
    const partitionDormant = jest
      .fn()
      .mockResolvedValue({ active: [mappings[0]], suppressed: 1 });
    const incScheduledSendSuppressed = jest.fn();

    const { service, claimAndSend } = buildService({
      mappings,
      webActivityService: { partitionDormant },
      metrics: { incScheduledSendSuppressed },
    });

    const result = await service.sendScheduledReports();

    expect(partitionDormant).toHaveBeenCalledWith(
      mappings,
      expect.any(Function),
    );
    expect(incScheduledSendSuppressed).toHaveBeenCalledWith('report', 1);
    expect(claimAndSend).toHaveBeenCalledTimes(1);
    expect(result.skipped).toBe(1);
  });

  it('does not consult the gate for an operator forceSend', async () => {
    const partitionDormant = jest.fn();
    const incScheduledSendSuppressed = jest.fn();

    const { service } = buildService({
      mappings: [mapping(1, 1)],
      webActivityService: { partitionDormant },
      metrics: { incScheduledSendSuppressed },
    });

    await service.sendScheduledReports({ forceSend: true });

    expect(partitionDormant).not.toHaveBeenCalled();
    expect(incScheduledSendSuppressed).not.toHaveBeenCalled();
  });
});
