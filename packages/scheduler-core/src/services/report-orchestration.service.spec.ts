/* eslint-disable @typescript-eslint/unbound-method -- Jest mock method assertions */
import { ReportOrchestrationService } from './report-orchestration.service';
import type { ReportClaimRepositoryPort } from '../ports/report-claim.repository.port';
import type { ReportDeliveryPort } from '../ports/report-delivery.port';
import type { ReportSendJobRepositoryPort } from '../ports/report-send-job.repository.port';
import { ReportSendScheduleService } from './report-send-schedule.service';

const MAPPING = {
  id: '1',
  platform: 'discord',
  externalUserId: 'discord-1',
  userId: 10,
  notificationCadence: 'daily',
  status: 'ACTIVE',
};

function buildClaimRepo(overrides: Partial<ReportClaimRepositoryPort> = {}) {
  return {
    hasSentScheduledReportOn: jest.fn().mockResolvedValue(false),
    hasAnyPlatformSentReportOn: jest.fn().mockResolvedValue(false),
    tryClaimScheduledReport: jest.fn().mockResolvedValue({
      claimed: true,
      leaseToken: 'token-1',
      deliveryRecord: undefined,
    }),
    markScheduledReportClaimSent: jest.fn().mockResolvedValue(undefined),
    releaseScheduledReportClaim: jest.fn().mockResolvedValue(undefined),
    listUserIdsWithSentReportOn: jest.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as ReportClaimRepositoryPort;
}

function buildDelivery(ok = true) {
  return {
    sendReport: jest.fn().mockResolvedValue({ ok }),
  } as unknown as ReportDeliveryPort;
}

function buildJobRepo(overrides: Partial<ReportSendJobRepositoryPort> = {}) {
  return {
    recordRetryableFailure: jest.fn().mockResolvedValue({}),
    markSentByExternalUserExamDate: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as ReportSendJobRepositoryPort;
}

function buildScheduleService() {
  return {
    getOutboxSettings: () => ({
      retryBackoffMinutes: 15,
      maxRetries: 3,
      claimLeaseMs: 7_200_000,
    }),
  } as unknown as ReportSendScheduleService;
}

describe('ReportOrchestrationService', () => {
  it('#829: records report delivery outcomes for the SLO counter', async () => {
    const metrics = { incReportDelivery: jest.fn() };
    const delivery = buildDelivery(true);
    const service = new ReportOrchestrationService(
      buildClaimRepo(),
      delivery,
      buildJobRepo(),
      buildScheduleService(),
      metrics,
    );

    await service.claimAndSend(MAPPING, {
      reportDate: '2026-08-07',
      skipAlreadySentToday: true,
      reportText: 'r',
    });
    expect(metrics.incReportDelivery).toHaveBeenCalledWith('sent');

    (delivery.sendReport as jest.Mock).mockResolvedValue({
      ok: false,
      reason: 'PERMANENT',
    });
    await service.claimAndSend(MAPPING, {
      reportDate: '2026-08-08',
      skipAlreadySentToday: true,
      reportText: 'r',
    });
    expect(metrics.incReportDelivery).toHaveBeenCalledWith('failed');
  });

  it('sends one report when two channel mappings share a learner claim', async () => {
    let learnerClaimed = false;
    const claimRepo = buildClaimRepo({
      tryClaimScheduledReport: jest.fn().mockImplementation(async () => {
        if (learnerClaimed) return { claimed: false };
        learnerClaimed = true;
        return { claimed: true, leaseToken: 'learner-lease' };
      }),
    });
    const delivery = buildDelivery(true);
    const generateReport = jest.fn().mockResolvedValue('one learner report');
    const service = new ReportOrchestrationService(
      claimRepo,
      delivery,
      buildJobRepo(),
      buildScheduleService(),
    );
    const opts = {
      reportDate: '2026-08-07',
      skipAlreadySentToday: true,
      reportText: '',
      generateReport,
    };

    const first = await service.claimAndSend(MAPPING, opts);
    const second = await service.claimAndSend(
      {
        ...MAPPING,
        id: '2',
        platform: 'zalo',
        externalUserId: 'zalo-1',
      },
      opts,
    );

    expect(first.sent).toBe(1);
    expect(second.claimSkipped).toBe(1);
    expect(generateReport).toHaveBeenCalledTimes(1);
    expect(delivery.sendReport).toHaveBeenCalledTimes(1);
  });

  it('skips a scheduled report when the mapping has no canonical learner id', async () => {
    const claimRepo = buildClaimRepo();
    const delivery = buildDelivery(true);
    const generateReport = jest
      .fn()
      .mockResolvedValue('should not be generated');
    const service = new ReportOrchestrationService(
      claimRepo,
      delivery,
      buildJobRepo(),
      buildScheduleService(),
    );

    const result = await service.claimAndSend(
      { ...MAPPING, userId: undefined },
      {
        reportDate: '2026-08-07',
        skipAlreadySentToday: true,
        reportText: '',
        generateReport,
      },
    );

    expect(result).toEqual(expect.objectContaining({ skipped: 1 }));
    expect(claimRepo.hasSentScheduledReportOn).not.toHaveBeenCalled();
    expect(claimRepo.tryClaimScheduledReport).not.toHaveBeenCalled();
    expect(generateReport).not.toHaveBeenCalled();
    expect(delivery.sendReport).not.toHaveBeenCalled();
  });

  it('uses the platform fallback claim for an explicitly allowed userId-less send', async () => {
    const claimRepo = buildClaimRepo();
    const delivery = buildDelivery(true);
    const service = new ReportOrchestrationService(
      claimRepo,
      delivery,
      buildJobRepo(),
      buildScheduleService(),
    );

    const result = await service.claimAndSend(
      { ...MAPPING, userId: undefined },
      {
        reportDate: '2026-08-07',
        skipAlreadySentToday: true,
        allowUserIdLess: true,
        reportText: 'fallback report',
      },
    );

    expect(result.sent).toBe(1);
    expect(claimRepo.hasSentScheduledReportOn).toHaveBeenCalledWith(
      'discord-1',
      '2026-08-07',
      undefined,
    );
    expect(claimRepo.tryClaimScheduledReport).toHaveBeenCalledWith(
      {
        externalUserId: 'discord-1',
        userId: undefined,
        reportDate: '2026-08-07',
      },
      expect.any(Number),
    );
    expect(delivery.sendReport).toHaveBeenCalled();
  });

  describe('generateReport callback', () => {
    it('generates report inside claim window and sends successfully', async () => {
      const claimRepo = buildClaimRepo();
      const delivery = buildDelivery(true);
      const jobRepo = buildJobRepo();
      const generateReport = jest.fn().mockResolvedValue('generated text');

      const service = new ReportOrchestrationService(
        claimRepo,
        delivery,
        jobRepo,
        buildScheduleService(),
      );

      const result = await service.claimAndSend(MAPPING, {
        reportDate: '2026-08-07',
        skipAlreadySentToday: true,
        reportText: '', // ignored
        generateReport,
      });

      expect(result.sent).toBe(1);
      expect(generateReport).toHaveBeenCalledTimes(1);
      expect(delivery.sendReport).toHaveBeenCalledWith(
        expect.objectContaining({ reportText: 'generated text' }),
      );
      expect(claimRepo.tryClaimScheduledReport).toHaveBeenCalled();
      expect(claimRepo.markScheduledReportClaimSent).toHaveBeenCalled();
    });

    it('records retryable failure when generation throws inside claim', async () => {
      const claimRepo = buildClaimRepo();
      const delivery = buildDelivery(true);
      const jobRepo = buildJobRepo();
      const generateReport = jest
        .fn()
        .mockRejectedValue(new Error('LLM timeout'));

      const service = new ReportOrchestrationService(
        claimRepo,
        delivery,
        jobRepo,
        buildScheduleService(),
      );

      const result = await service.claimAndSend(MAPPING, {
        reportDate: '2026-08-07',
        skipAlreadySentToday: true,
        reportText: '',
        generateReport,
      });

      expect(result.deferred).toBe(1);
      expect(result.retryQueued).toBe(1);
      expect(result.sent).toBe(0);
      expect(claimRepo.releaseScheduledReportClaim).toHaveBeenCalled();
      expect(jobRepo.recordRetryableFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          errorMessage: expect.stringContaining('Generation failed'),
        }),
      );
      // Delivery should NOT be called after generation failure
      expect(delivery.sendReport).not.toHaveBeenCalled();
    });

    it('persists capacity overload as the durable retry cause', async () => {
      const claimRepo = buildClaimRepo();
      const jobRepo = buildJobRepo();
      const service = new ReportOrchestrationService(
        claimRepo,
        buildDelivery(true),
        jobRepo,
        buildScheduleService(),
      );

      const result = await service.claimAndSend(MAPPING, {
        reportDate: '2026-08-07',
        skipAlreadySentToday: true,
        reportText: '',
        generateReport: jest.fn().mockRejectedValue(new Error('queue full')),
        classifyError: () => ({
          kind: 'retryable',
          message: 'capacity overloaded',
          retryCause: 'capacity_overload',
        }),
      });

      expect(result).toEqual(
        expect.objectContaining({ deferred: 1, retryQueued: 1 }),
      );
      expect(jobRepo.recordRetryableFailure).toHaveBeenCalledWith(
        expect.objectContaining({ retryCause: 'capacity_overload' }),
      );
    });

    it('falls back to reportText when generateReport is not provided', async () => {
      const claimRepo = buildClaimRepo();
      const delivery = buildDelivery(true);
      const jobRepo = buildJobRepo();

      const service = new ReportOrchestrationService(
        claimRepo,
        delivery,
        jobRepo,
        buildScheduleService(),
      );

      const result = await service.claimAndSend(MAPPING, {
        reportDate: '2026-08-07',
        skipAlreadySentToday: true,
        reportText: 'pre-generated text',
      });

      expect(result.sent).toBe(1);
      expect(delivery.sendReport).toHaveBeenCalledWith(
        expect.objectContaining({ reportText: 'pre-generated text' }),
      );
    });

    it('persists an ambiguous provider outcome as terminal claim state', async () => {
      const claimRepo = buildClaimRepo();
      const delivery = {
        sendReport: jest.fn().mockResolvedValue({
          ok: true,
          outcome: 'ambiguous',
        }),
      } as unknown as ReportDeliveryPort;

      const service = new ReportOrchestrationService(
        claimRepo,
        delivery,
        buildJobRepo(),
        buildScheduleService(),
      );

      const result = await service.claimAndSend(MAPPING, {
        reportDate: '2026-08-07',
        skipAlreadySentToday: true,
        reportText: 'pre-generated text',
      });

      expect(result.sent).toBe(1);
      expect(claimRepo.markScheduledReportClaimSent).toHaveBeenCalledWith(
        { externalUserId: 'discord-1', userId: 10, reportDate: '2026-08-07' },
        'token-1',
        'sent',
        expect.any(String),
        'ambiguous',
      );
    });

    it('does not misclassify permanent delivery failures as a closed window', async () => {
      const claimRepo = buildClaimRepo();
      const delivery = buildDelivery(false);
      (delivery.sendReport as jest.Mock).mockResolvedValue({
        ok: false,
        reason: 'DELIVERY_FAILED',
      });
      const service = new ReportOrchestrationService(
        claimRepo,
        delivery,
        buildJobRepo(),
        buildScheduleService(),
      );

      const result = await service.claimAndSend(MAPPING, {
        reportDate: '2026-08-07',
        skipAlreadySentToday: true,
        reportText: 'pre-generated text',
      });

      expect(result.windowClosed).toBe(0);
      expect(result.failures).toEqual([
        { externalUserId: 'discord-1', error: 'DELIVERY_FAILED' },
      ]);
    });

    it('burns the scheduled claim and does not enqueue a rate-limited report', async () => {
      const claimRepo = buildClaimRepo();
      const delivery = {
        sendReport: jest.fn().mockResolvedValue({
          ok: false,
          reason: 'RATE_LIMITED',
          outcome: 'rate_limited',
        }),
      } as unknown as ReportDeliveryPort;
      const jobRepo = buildJobRepo();

      const service = new ReportOrchestrationService(
        claimRepo,
        delivery,
        jobRepo,
        buildScheduleService(),
      );

      const result = await service.claimAndSend(MAPPING, {
        reportDate: '2026-08-07',
        skipAlreadySentToday: true,
        reportText: 'pre-generated text',
        examDateForOutbox: '2026-08-20',
      });

      expect(result.failures).toEqual([
        { externalUserId: 'discord-1', error: 'outbound_rate_limited' },
      ]);
      expect(result.retryQueued).toBe(0);
      expect(jobRepo.recordRetryableFailure).not.toHaveBeenCalled();
      expect(claimRepo.releaseScheduledReportClaim).not.toHaveBeenCalled();
      expect(claimRepo.markScheduledReportClaimSent).toHaveBeenCalledWith(
        { externalUserId: 'discord-1', userId: 10, reportDate: '2026-08-07' },
        'token-1',
        undefined,
        expect.any(String),
        'rate_limited',
      );
    });

    it('counts an inactive mapping as skipped', async () => {
      const claimRepo = buildClaimRepo();
      const delivery = buildDelivery(false);
      (delivery.sendReport as jest.Mock).mockResolvedValue({
        ok: false,
        reason: 'NOT_LINKED',
      });
      const service = new ReportOrchestrationService(
        claimRepo,
        delivery,
        buildJobRepo(),
        buildScheduleService(),
      );

      const result = await service.claimAndSend(MAPPING, {
        reportDate: '2026-08-07',
        skipAlreadySentToday: true,
        reportText: 'pre-generated text',
      });

      expect(result.skipped).toBe(1);
      expect(result.windowClosed).toBe(0);
    });

    it('preserves a skipped exception classification', async () => {
      const claimRepo = buildClaimRepo();
      const delivery = buildDelivery(true);
      const service = new ReportOrchestrationService(
        claimRepo,
        delivery,
        null,
        buildScheduleService(),
      );

      const result = await service.claimAndSend(MAPPING, {
        reportDate: '2026-08-07',
        skipAlreadySentToday: true,
        reportText: 'pre-generated text',
        classifyError: () => ({
          kind: 'skipped',
          message: 'mapping revoked',
        }),
        generateReport: jest.fn().mockRejectedValue(new Error('revoked')),
      });

      expect(result.skipped).toBe(1);
      expect(result.windowClosed).toBe(0);
    });
  });
});
