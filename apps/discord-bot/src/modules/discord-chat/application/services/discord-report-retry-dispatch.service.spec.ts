import { DiscordReportRetryDispatchService } from './discord-report-retry-dispatch.service';

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
  createdAt: new Date(),
  updatedAt: new Date(),
};

const LINK = {
  id: '1',
  platform: 'discord',
  externalUserId: 'discord-1',
  userId: 10,
  linkedAt: new Date(),
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
      failures: Array<{ externalUserId: string; error: string }>;
    };
    resetStuck?: number;
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

    const accountLinkRepo = {
      findOne: jest
        .fn()
        .mockResolvedValue(
          overrides?.link !== undefined ? overrides.link : LINK,
        ),
    };

    const service = new DiscordReportRetryDispatchService(
      { get: jest.fn() } as never,
      jobRepository as never,
      orchestrationService as never,
      accountLinkRepo as never,
    );

    return { service, jobRepository, orchestrationService, accountLinkRepo };
  };

  it('picks up due job, claims, sends and marks sent', async () => {
    const { service, jobRepository, orchestrationService, accountLinkRepo } =
      buildService({ dueJobs: [JOB] });

    const result = await service.dispatchDueReportRetries();

    expect(jobRepository.resetStuckProcessingJobs).toHaveBeenCalled();
    expect(jobRepository.findDueJobs).toHaveBeenCalledWith(expect.any(Date));
    expect(jobRepository.claimJob).toHaveBeenCalledWith(1);
    expect(accountLinkRepo.findOne).toHaveBeenCalledWith({
      where: { platform: 'discord', externalUserId: 'discord-1' },
    });
    expect(orchestrationService.claimAndSend).toHaveBeenCalledWith(
      expect.objectContaining({ externalUserId: 'discord-1' }),
      {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        reportDate: expect.any(String),
        skipAlreadySentToday: false,
        examDateForOutbox: '2026-08-20',
      },
    );
    expect(jobRepository.markSent).toHaveBeenCalledWith(1);
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
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
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
});
