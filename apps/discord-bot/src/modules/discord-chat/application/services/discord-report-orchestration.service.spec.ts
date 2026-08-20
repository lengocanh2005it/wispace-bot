import { DiscordReportOrchestrationService } from './discord-report-orchestration.service';

const MAPPING = {
  id: '1',
  platform: 'discord',
  externalUserId: 'discord-1',
  userId: 10,
  notificationCadence: 'daily',
  status: 'ACTIVE',
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

describe('DiscordReportOrchestrationService.claimAndSend', () => {
  const buildService = (overrides?: {
    alreadySent?: boolean;
    claimOk?: boolean;
    sendResult?: { ok: boolean; reason?: 'RETRYABLE' | 'WINDOW_CLOSED' };
    sendError?: Error;
  }) => {
    const claimRepository = {
      hasSentScheduledReportToday: jest
        .fn()
        .mockResolvedValue(overrides?.alreadySent ?? false),
      tryClaimScheduledReport: jest
        .fn()
        .mockResolvedValue(
          overrides?.claimOk === false
            ? { claimed: false }
            : { claimed: true, leaseToken: 'lease-1' },
        ),
      markScheduledReportClaimSent: jest.fn().mockResolvedValue(undefined),
      releaseScheduledReportClaim: jest.fn().mockResolvedValue(undefined),
    };

    const deliveryService = {
      sendReport: overrides?.sendError
        ? jest.fn().mockRejectedValue(overrides.sendError)
        : jest.fn().mockResolvedValue(overrides?.sendResult ?? { ok: true }),
    };

    const jobRepository = {
      markSentByExternalUserExamDate: jest.fn().mockResolvedValue(undefined),
      recordRetryableFailure: jest
        .fn()
        .mockResolvedValue({ nextRetryAt: new Date() }),
    };

    const goalsService = {
      getUserGoals: jest
        .fn()
        .mockResolvedValue({ targetScore: 7, examDate: '2026-07-15' }),
    };

    const reportService = {
      generateReport: jest.fn().mockResolvedValue('report text'),
    };

    const reportSendScheduleService = {
      getOutboxSettings: jest.fn().mockReturnValue({
        maxRetries: 3,
        retryBackoffMinutes: 15,
      }),
    };

    const service = new DiscordReportOrchestrationService(
      claimRepository as never,
      deliveryService,
      jobRepository as never,
      goalsService as never,
      reportService as never,
      {} as never,
      reportSendScheduleService as never,
      { get: jest.fn() } as never,
    );

    return {
      service,
      claimRepository,
      deliveryService,
      jobRepository,
      goalsService,
      reportService,
    };
  };

  it('happy path: claim → generate → send → markSent → sent=1', async () => {
    const {
      service,
      claimRepository,
      deliveryService,
      goalsService,
      reportService,
    } = buildService();

    const result = await service.claimAndSend(MAPPING, {
      reportDate: '2026-08-07',
      skipAlreadySentToday: true,
      examDateForOutbox: '2026-08-20',
    });

    expect(result.sent).toBe(1);
    expect(result.skipped).toBe(0);
    expect(claimRepository.tryClaimScheduledReport).toHaveBeenCalledWith(
      {
        externalUserId: 'discord-1',
        userId: 10,
        reportDate: '2026-08-07',
      },
      expect.any(Number),
    );
    expect(goalsService.getUserGoals).toHaveBeenCalledWith('discord-1');
    expect(reportService.generateReport).toHaveBeenCalledWith('discord-1');
    expect(deliveryService.sendReport).toHaveBeenCalledWith({
      mapping: MAPPING,
      reportText: 'report text',
      reportDate: '2026-08-07',
      deliveryKey: 'discord-report:discord-1:2026-08-07',
    });
    expect(claimRepository.markScheduledReportClaimSent).toHaveBeenCalledWith(
      {
        externalUserId: 'discord-1',
        reportDate: '2026-08-07',
      },
      'lease-1',
      'sent',
      'discord-report:discord-1:2026-08-07',
    );
  });

  it('already sent today → skipped=1, no claim or send', async () => {
    const { service, claimRepository, deliveryService, jobRepository } =
      buildService({ alreadySent: true });

    const result = await service.claimAndSend(MAPPING, {
      reportDate: '2026-08-07',
      skipAlreadySentToday: true,
      examDateForOutbox: '2026-08-20',
    });

    expect(result).toEqual({ ...ZERO_RESULT, skipped: 1 });
    expect(claimRepository.tryClaimScheduledReport).not.toHaveBeenCalled();
    expect(deliveryService.sendReport).not.toHaveBeenCalled();
    expect(jobRepository.markSentByExternalUserExamDate).toHaveBeenCalledWith(
      'discord-1',
      '2026-08-20',
    );
  });

  it('claim conflict → claimSkipped=1, no send', async () => {
    const { service, deliveryService } = buildService({ claimOk: false });

    const result = await service.claimAndSend(MAPPING, {
      reportDate: '2026-08-07',
      skipAlreadySentToday: true,
    });

    expect(result).toEqual({ ...ZERO_RESULT, claimSkipped: 1 });
    expect(deliveryService.sendReport).not.toHaveBeenCalled();
  });

  it('send fails RETRYABLE → release claim + queue retry', async () => {
    const { service, claimRepository, jobRepository } = buildService({
      sendResult: { ok: false, reason: 'RETRYABLE' },
    });

    const result = await service.claimAndSend(MAPPING, {
      reportDate: '2026-08-07',
      skipAlreadySentToday: true,
      examDateForOutbox: '2026-08-20',
    });

    expect(result.deferred).toBe(1);
    expect(result.retryQueued).toBe(1);
    expect(claimRepository.releaseScheduledReportClaim).toHaveBeenCalledWith(
      {
        externalUserId: 'discord-1',
        reportDate: '2026-08-07',
      },
      'lease-1',
    );
    expect(jobRepository.recordRetryableFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        externalUserId: 'discord-1',
        examDate: '2026-07-15',
        maxRetries: 3,
      }),
    );
  });

  it('send fails WINDOW_CLOSED → release claim', async () => {
    const { service, claimRepository } = buildService({
      sendResult: { ok: false, reason: 'WINDOW_CLOSED' },
    });

    const result = await service.claimAndSend(MAPPING, {
      reportDate: '2026-08-07',
      skipAlreadySentToday: true,
    });

    expect(result).toEqual({ ...ZERO_RESULT, windowClosed: 1 });
    expect(claimRepository.releaseScheduledReportClaim).toHaveBeenCalledWith(
      {
        externalUserId: 'discord-1',
        reportDate: '2026-08-07',
      },
      'lease-1',
    );
  });

  it('send throws → release claim, failure counted', async () => {
    const { service, claimRepository } = buildService({
      sendError: new Error('boom'),
    });

    const result = await service.claimAndSend(MAPPING, {
      reportDate: '2026-08-07',
      skipAlreadySentToday: true,
    });

    expect(result.failures).toEqual([
      { externalUserId: 'discord-1', error: 'boom' },
    ]);
    expect(claimRepository.releaseScheduledReportClaim).toHaveBeenCalled();
  });
});
