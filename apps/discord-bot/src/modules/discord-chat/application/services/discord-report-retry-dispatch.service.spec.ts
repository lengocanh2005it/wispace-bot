import { DiscordReportRetryDispatchService } from './discord-report-retry-dispatch.service';
import { ADVISORY_LOCKS } from '@wispace/bot-common/locks';

const JOB = {
  id: 1,
  platform: 'discord',
  externalUserId: 'discord-1',
  userId: 10,
  examDate: '2026-08-20',
  firstAttemptDate: '2026-08-07',
  status: 'pending',
  retryCount: 0,
  maxRetries: 3,
  leaseToken: 'lease-1',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const LINK = {
  id: '1',
  userId: 10,
  linkState: 'active',
};

const SENT_RESULT = {
  sent: 1,
  skipped: 0,
  deferred: 0,
  windowClosed: 0,
  claimSkipped: 0,
  retryQueued: 0,
  failures: [],
};

describe('DiscordReportRetryDispatchService.dispatchDueReportRetries', () => {
  const buildService = (overrides?: {
    dueJobs?: (typeof JOB)[];
    claimResult?: typeof JOB | null;
    link?: typeof LINK | null;
    claimAndSendResult?: {
      sent: number;
      skipped?: number;
      deferred?: number;
      windowClosed?: number;
      claimSkipped?: number;
      failures: Array<{ externalUserId: string; error: string }>;
    };
    resetStuck?: number;
    leaderAnswer?: boolean;
    lockContended?: boolean;
    leaseMsRaw?: string;
  }) => {
    const jobRepository = {
      resetStuckProcessingJobs: jest
        .fn()
        .mockResolvedValue(overrides?.resetStuck ?? 0),
      findDueJobs: jest.fn().mockResolvedValue(overrides?.dueJobs ?? []),
      claimJob: jest
        .fn()
        .mockResolvedValue(
          overrides?.claimResult !== undefined ? overrides.claimResult : JOB,
        ),
      markSent: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    };

    const orchestrationService = {
      claimAndSend: jest
        .fn()
        .mockResolvedValue(overrides?.claimAndSendResult ?? SENT_RESULT),
    };

    const accountLinkReader = {
      findLinkStateByExternalUserId: jest
        .fn()
        .mockResolvedValue(
          overrides?.link !== undefined ? overrides.link : LINK,
        ),
    };

    const reportCronLeaderService = {
      shouldRunScheduledReportCron: jest
        .fn()
        .mockResolvedValue(overrides?.leaderAnswer ?? true),
    };

    const pgLock = {
      withLock: jest.fn((_lockId: number, fn: () => Promise<unknown>) =>
        overrides?.lockContended ? Promise.resolve(null) : fn(),
      ),
    };

    const configService = {
      get: jest.fn((key: string) =>
        overrides?.leaseMsRaw && key === 'REPORT_SEND_LEASE_MS'
          ? overrides.leaseMsRaw
          : undefined,
      ),
    };

    const service = new DiscordReportRetryDispatchService(
      configService as never,
      jobRepository as never,
      orchestrationService as never,
      accountLinkReader as never,
      reportCronLeaderService as never,
      pgLock as never,
    );

    return {
      service,
      jobRepository,
      orchestrationService,
      accountLinkReader,
      reportCronLeaderService,
      pgLock,
    };
  };

  it('picks up due job, claims, sends and marks sent', async () => {
    const { service, jobRepository, orchestrationService, accountLinkReader } =
      buildService({ dueJobs: [JOB] });

    const result = await service.dispatchDueReportRetries();

    expect(jobRepository.resetStuckProcessingJobs).toHaveBeenCalled();
    expect(jobRepository.findDueJobs).toHaveBeenCalledWith(expect.any(Date));
    expect(jobRepository.claimJob).toHaveBeenCalledWith(1, 600_000);
    expect(
      accountLinkReader.findLinkStateByExternalUserId,
    ).toHaveBeenCalledWith('discord-1');
    expect(orchestrationService.claimAndSend).toHaveBeenCalledWith(
      expect.objectContaining({ externalUserId: 'discord-1' }),
      {
        reportDate: JOB.firstAttemptDate,
        skipAlreadySentToday: true,
        examDateForOutbox: '2026-08-20',
        attempt: 'retry',
      },
    );
    expect(jobRepository.markSent).toHaveBeenCalledWith(1, 'lease-1');
    expect(result.sent).toBe(1);
  });

  it('skips job when claim fails', async () => {
    const { service, jobRepository, orchestrationService } = buildService({
      dueJobs: [JOB],
      claimResult: null,
    });

    const result = await service.dispatchDueReportRetries();

    expect(orchestrationService.claimAndSend).not.toHaveBeenCalled();
    expect(jobRepository.markSent).not.toHaveBeenCalled();
    expect(result.sent).toBe(0);
  });

  it('marks job failed terminally when no active link', async () => {
    const { service, jobRepository, orchestrationService } = buildService({
      dueJobs: [JOB],
      link: null,
    });

    const result = await service.dispatchDueReportRetries();

    expect(orchestrationService.claimAndSend).not.toHaveBeenCalled();
    expect(jobRepository.markFailed).toHaveBeenCalledWith({
      jobId: 1,
      leaseToken: 'lease-1',
      errorMessage: 'No active Discord account link',
      retryCount: 1,
      terminal: true,
    });
    expect(result.failed).toBe(1);
  });

  it('marks failed with next retry when not terminal', async () => {
    const { service, jobRepository } = buildService({
      dueJobs: [JOB],
      claimAndSendResult: {
        sent: 0,
        failures: [{ externalUserId: 'discord-1', error: 'delivery down' }],
      },
    });

    const result = await service.dispatchDueReportRetries();

    expect(jobRepository.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 1,
        errorMessage: 'delivery down',
        retryCount: 1,
        terminal: false,
        nextRetryAt: expect.any(Date),
      }),
    );
    expect(result.retryQueued).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('marks failed terminally at max retries', async () => {
    const { service, jobRepository } = buildService({
      dueJobs: [{ ...JOB, retryCount: 2, maxRetries: 3 }],
      claimAndSendResult: {
        sent: 0,
        failures: [{ externalUserId: 'discord-1', error: 'delivery down' }],
      },
    });

    const result = await service.dispatchDueReportRetries();

    expect(jobRepository.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 1, retryCount: 3, terminal: true }),
    );
    expect(result.failed).toBe(1);
    expect(result.failures).toEqual([
      { externalUserId: 'discord-1', error: 'delivery down' },
    ]);
  });

  it('marks a rate-limited report terminally without scheduling another retry', async () => {
    const { service, jobRepository } = buildService({
      dueJobs: [JOB],
      claimAndSendResult: {
        sent: 0,
        failures: [
          { externalUserId: 'discord-1', error: 'outbound_rate_limited' },
        ],
      },
    });

    const result = await service.dispatchDueReportRetries();

    expect(jobRepository.markFailed).toHaveBeenCalledWith({
      jobId: 1,
      leaseToken: 'lease-1',
      errorMessage: 'outbound_rate_limited',
      retryCount: 1,
      terminal: true,
    });
    expect(result.retryQueued).toBe(0);
    expect(result.failed).toBe(1);
  });

  it('deferred outcome: parks the job with a future next_retry_at instead of stranding it (#521)', async () => {
    const { service, jobRepository } = buildService({
      dueJobs: [JOB],
      claimAndSendResult: { sent: 0, deferred: 1, failures: [] },
    });

    const result = await service.dispatchDueReportRetries();

    expect(jobRepository.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 1,
        leaseToken: 'lease-1',
        retryCount: 1,
        terminal: false,
        nextRetryAt: expect.any(Date),
      }),
    );
    expect(result.retryQueued).toBe(1);
    expect(result.sent).toBe(0);
  });

  it('deferred outcome is terminal at max retries (#521)', async () => {
    const { service, jobRepository } = buildService({
      dueJobs: [{ ...JOB, retryCount: 2, maxRetries: 3 }],
      claimAndSendResult: { sent: 0, deferred: 1, failures: [] },
    });

    const result = await service.dispatchDueReportRetries();

    expect(jobRepository.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 1, retryCount: 3, terminal: true }),
    );
    expect(result.failed).toBe(1);
  });

  it('windowClosed outcome: expires the job terminally (#521)', async () => {
    const { service, jobRepository } = buildService({
      dueJobs: [JOB],
      claimAndSendResult: { sent: 0, windowClosed: 1, failures: [] },
    });

    const result = await service.dispatchDueReportRetries();

    expect(jobRepository.markFailed).toHaveBeenCalledWith({
      jobId: 1,
      leaseToken: 'lease-1',
      errorMessage: 'Exam window closed',
      retryCount: 3,
      terminal: true,
    });
    expect(result.windowClosed).toBe(1);
  });

  it('claimSkipped outcome: requeues without consuming a retry — the claim owner is still working (#521)', async () => {
    const { service, jobRepository } = buildService({
      dueJobs: [JOB],
      claimAndSendResult: { sent: 0, claimSkipped: 1, failures: [] },
    });

    const result = await service.dispatchDueReportRetries();

    expect(jobRepository.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 1,
        leaseToken: 'lease-1',
        retryCount: 0,
        terminal: false,
        nextRetryAt: expect.any(Date),
      }),
    );
    expect(result.retryQueued).toBe(1);
  });

  it('resetStuckProcessingJobs uses a stuck threshold strictly above the lease (2x) — slow sends are not reclaimed (#521)', async () => {
    const { service, jobRepository } = buildService({ dueJobs: [] });

    await service.dispatchDueReportRetries();

    const cutoff = (jobRepository.resetStuckProcessingJobs as jest.Mock).mock
      .calls[0][0] as Date;
    const ageMs = Date.now() - cutoff.getTime();
    expect(ageMs).toBeGreaterThanOrEqual(1_200_000 - 5_000);
    expect(ageMs).toBeLessThan(1_200_000 + 5_000);
  });

  it('continues the due batch after one item throws', async () => {
    const secondJob = { ...JOB, id: 2, externalUserId: 'discord-2' };
    const built = buildService({ dueJobs: [JOB, secondJob] });
    built.accountLinkReader.findLinkStateByExternalUserId = jest
      .fn()
      .mockRejectedValueOnce(new Error('temporary lookup failure'))
      .mockResolvedValueOnce(LINK);

    const result = await built.service.dispatchDueReportRetries();

    expect(result.failed).toBe(1);
    expect(result.sent).toBe(1);
    expect(built.jobRepository.claimJob).toHaveBeenCalledTimes(2);
  });

  it('resetStuckProcessingJobs follows a custom lease from REPORT_SEND_LEASE_MS (2x invariant) (#521)', async () => {
    const { service, jobRepository } = buildService({
      dueJobs: [],
      leaseMsRaw: '1200000',
    });

    await service.dispatchDueReportRetries();

    const cutoff = (jobRepository.resetStuckProcessingJobs as jest.Mock).mock
      .calls[0][0] as Date;
    const ageMs = Date.now() - cutoff.getTime();
    expect(ageMs).toBeGreaterThanOrEqual(2_400_000 - 5_000);
    expect(ageMs).toBeLessThan(2_400_000 + 5_000);
  });

  it('slow-send regression: recovery reopens only past the 2x threshold, so the slow owner keeps its token (#113, #521)', async () => {
    // First tick claims with lease-a; the send is slow. Second tick runs
    // before the 2x stuck threshold — nothing is reset, the job stays
    // processing, and the slow owner's markSent lands on its own token.
    let resolveSlowSend!: () => void;
    const slowSendGate = new Promise<void>((resolve) => {
      resolveSlowSend = resolve;
    });
    let claimAndSendCalls = 0;
    const firstClaim = { ...JOB, leaseToken: 'lease-a' };

    const built = buildService({ dueJobs: [] });
    const jobRepository = built.jobRepository;
    const orchestrationService = built.orchestrationService;
    // Script the slow send + tick-scoped due jobs on the shared mocks.
    jobRepository.findDueJobs = jest
      .fn()
      .mockResolvedValueOnce([firstClaim])
      .mockResolvedValueOnce([]); // nothing reset → not due again
    jobRepository.claimJob = jest.fn().mockResolvedValueOnce(firstClaim);
    orchestrationService.claimAndSend = jest
      .fn()
      .mockImplementation(async () => {
        claimAndSendCalls += 1;
        if (claimAndSendCalls === 1) {
          await slowSendGate;
        }
        return SENT_RESULT;
      });
    const service = built.service;

    const first = service.dispatchDueReportRetries();
    await service.dispatchDueReportRetries();
    resolveSlowSend();
    await first;

    expect(claimAndSendCalls).toBe(1);
    expect(jobRepository.markSent).toHaveBeenCalledTimes(1);
    expect(jobRepository.markSent).toHaveBeenCalledWith(1, 'lease-a');
  });
});

describe('DiscordReportRetryDispatchService.handleRetryDispatch (#521)', () => {
  const buildHandler = (overrides?: {
    leaderAnswer?: boolean;
    lockContended?: boolean;
  }) => {
    const jobRepository = {
      resetStuckProcessingJobs: jest.fn().mockResolvedValue(0),
      findDueJobs: jest.fn().mockResolvedValue([]),
      claimJob: jest.fn(),
      markSent: jest.fn(),
      markFailed: jest.fn(),
    };
    const reportCronLeaderService = {
      shouldRunScheduledReportCron: jest
        .fn()
        .mockResolvedValue(overrides?.leaderAnswer ?? true),
    };
    const pgLock = {
      withLock: jest.fn((_lockId: number, fn: () => Promise<unknown>) =>
        overrides?.lockContended ? Promise.resolve(null) : fn(),
      ),
    };
    const service = new DiscordReportRetryDispatchService(
      { get: jest.fn() } as never,
      jobRepository as never,
      { claimAndSend: jest.fn() } as never,
      {
        findLinkStateByExternalUserId: jest.fn(),
      } as never,
      reportCronLeaderService as never,
      pgLock as never,
    );
    return { service, jobRepository, reportCronLeaderService, pgLock };
  };

  it('runs dispatch under the platform-scoped advisory lock when leader', async () => {
    const { service, pgLock } = buildHandler();

    await service.handleRetryDispatch();

    expect(pgLock.withLock).toHaveBeenCalledWith(
      ADVISORY_LOCKS.DISCORD_REPORT_RETRY_DISPATCH,
      expect.any(Function),
    );
    expect(ADVISORY_LOCKS.DISCORD_REPORT_RETRY_DISPATCH).toBe(884_200_951);
  });

  it('leader says no → nothing runs', async () => {
    const { service, pgLock } = buildHandler({ leaderAnswer: false });

    await service.handleRetryDispatch();

    expect(pgLock.withLock).not.toHaveBeenCalled();
  });

  it('lock contention → dispatch skipped, no throw', async () => {
    const { service, jobRepository } = buildHandler({ lockContended: true });

    await expect(service.handleRetryDispatch()).resolves.not.toThrow();
    expect(jobRepository.findDueJobs).not.toHaveBeenCalled();
  });
});
