import { ReportSendRetryDispatchService } from './report-send-retry-dispatch.service';
import { ADVISORY_LOCK } from '@messenger/shared/common/advisory-lock-ids';

const JOB = {
  id: 1,
  platform: 'messenger',
  externalUserId: 'psid-1',
  userId: 10,
  examDate: '2026-08-20',
  firstAttemptDate: '2026-08-07',
  status: 'pending' as const,
  retryCount: 0,
  maxRetries: 3,
  leaseToken: 'lease-1',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const MAPPING = {
  id: 1,
  userId: 10,
  psid: 'psid-1',
  notificationMessagesToken: 'token',
  status: 'ACTIVE' as const,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const SETTINGS = {
  maxRetries: 3,
  retryBackoffMinutes: 15,
  retryPollCronMinutes: 15,
  leaseMs: 600_000,
  claimLeaseMs: 7_200_000,
  timezone: 'Asia/Ho_Chi_Minh',
};

describe('ReportSendRetryDispatchService', () => {
  const buildService = (overrides?: {
    dueJobs?: (typeof JOB)[];
    claimResult?: typeof JOB | null;
    sendResult?: {
      sent: number;
      skipped?: number;
      deferred?: number;
      windowClosed?: number;
      claimSkipped?: number;
      failures: Array<{ externalUserId: string; error: string }>;
    };
    leaderAnswer?: boolean;
  }) => {
    const reportSendJobRepository = {
      resetStuckProcessingJobs: jest.fn().mockResolvedValue(0),
      findDueJobs: jest.fn().mockResolvedValue(overrides?.dueJobs ?? []),
      claimJob: jest
        .fn()
        .mockResolvedValue(
          overrides?.claimResult !== undefined ? overrides.claimResult : JOB,
        ),
      markSent: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    };
    const messengerRepository = {
      findActiveMappingByPsid: jest.fn().mockResolvedValue(MAPPING),
      findMappingStateByPsid: jest.fn().mockResolvedValue('active'),
    };
    const reportScheduleService = {
      shouldSendReportToday: jest.fn().mockResolvedValue({
        shouldSend: true,
        daysUntilExam: 10,
        examDate: JOB.examDate,
        minDays: 2,
        maxDays: 3,
      }),
      calculateDaysUntilExam: jest.fn().mockReturnValue(10),
    };
    const reportSendScheduleService = {
      getOutboxSettings: jest.fn().mockReturnValue(SETTINGS),
    };
    const reportCronLeaderService = {
      shouldRunScheduledReportCron: jest
        .fn()
        .mockResolvedValue(overrides?.leaderAnswer ?? true),
    };
    const reportSendOrchestrationService = {
      claimAndSend: jest.fn().mockResolvedValue(
        overrides?.sendResult ?? {
          sent: 1,
          skipped: 0,
          deferred: 0,
          windowClosed: 0,
          claimSkipped: 0,
          retryQueued: 0,
          failures: [],
        },
      ),
    };
    const pgLock = {
      withLock: jest.fn((_lockId: number, run: () => Promise<unknown>) =>
        run(),
      ),
    };

    const service = new ReportSendRetryDispatchService(
      reportSendJobRepository as never,
      messengerRepository as never,
      reportScheduleService as never,
      reportSendScheduleService as never,
      reportCronLeaderService as never,
      reportSendOrchestrationService as never,
      pgLock as never,
    );

    return {
      service,
      reportSendJobRepository,
      reportSendOrchestrationService,
      reportCronLeaderService,
      pgLock,
    };
  };

  it('claims, sends, and marks a due report job sent', async () => {
    const built = buildService({ dueJobs: [JOB] });

    const result = await built.service.dispatchDueReportRetries();

    expect(result.sent).toBe(1);
    expect(built.reportSendJobRepository.claimJob).toHaveBeenCalledWith(
      JOB.id,
      SETTINGS.leaseMs,
    );
    expect(built.reportSendJobRepository.markSent).toHaveBeenCalledWith(
      JOB.id,
      JOB.leaseToken,
    );
    expect(
      built.reportSendOrchestrationService.claimAndSend,
    ).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reportDate: JOB.firstAttemptDate }),
    );
  });

  it('parks a deferred send with a future retry and keeps the lease fence', async () => {
    const built = buildService({
      dueJobs: [JOB],
      sendResult: { sent: 0, deferred: 1, failures: [] },
    });

    const result = await built.service.dispatchDueReportRetries();

    expect(result.retried).toBe(1);
    expect(built.reportSendJobRepository.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: JOB.id,
        leaseToken: JOB.leaseToken,
        retryCount: 1,
        terminal: false,
        nextRetryAt: expect.any(Date),
      }),
    );
  });

  it('continues the bounded batch after one item fails', async () => {
    const secondJob = { ...JOB, id: 2, externalUserId: 'psid-2' };
    const built = buildService({ dueJobs: [JOB, secondJob] });
    built.reportSendOrchestrationService.claimAndSend = jest
      .fn()
      .mockRejectedValueOnce(new Error('temporary send failure'))
      .mockResolvedValueOnce({
        sent: 1,
        skipped: 0,
        deferred: 0,
        windowClosed: 0,
        claimSkipped: 0,
        retryQueued: 0,
        failures: [],
      });

    const result = await built.service.dispatchDueReportRetries();

    expect(result.failed).toBe(1);
    expect(result.sent).toBe(1);
    expect(built.reportSendJobRepository.claimJob).toHaveBeenCalledTimes(2);
  });

  it('runs the retry tick under its PostgreSQL advisory lock', async () => {
    const built = buildService();

    await built.service.handleReportSendRetryCron();

    expect(
      built.reportCronLeaderService.shouldRunScheduledReportCron,
    ).toHaveBeenCalled();
    expect(built.pgLock.withLock).toHaveBeenCalledWith(
      ADVISORY_LOCK.REPORT_SEND_RETRY_DISPATCH,
      expect.any(Function),
    );
  });
});
