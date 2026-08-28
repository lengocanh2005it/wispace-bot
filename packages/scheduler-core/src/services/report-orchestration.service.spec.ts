/* eslint-disable @typescript-eslint/unbound-method -- Jest mock method assertions */
import { ConfigService } from '@nestjs/config';
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

function buildConfig(overrides: Record<string, string> = {}) {
  return {
    get: jest.fn(
      (key: string) =>
        ({
          REPORT_CLAIM_STALE_RESET_MS: undefined,
          ...overrides,
        })[key],
    ),
  } as unknown as ConfigService;
}

function buildClaimRepo(overrides: Partial<ReportClaimRepositoryPort> = {}) {
  return {
    hasSentScheduledReportToday: jest.fn().mockResolvedValue(false),
    hasAnyPlatformSentReportToday: jest.fn().mockResolvedValue(false),
    tryClaimScheduledReport: jest.fn().mockResolvedValue({
      claimed: true,
      leaseToken: 'token-1',
      deliveryRecord: undefined,
    }),
    markScheduledReportClaimSent: jest.fn().mockResolvedValue(undefined),
    releaseScheduledReportClaim: jest.fn().mockResolvedValue(undefined),
    listUserIdsWithSentReportToday: jest.fn().mockResolvedValue([]),
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
    }),
  } as unknown as ReportSendScheduleService;
}

describe('ReportOrchestrationService', () => {
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
        buildConfig(),
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
        buildConfig(),
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

    it('falls back to reportText when generateReport is not provided', async () => {
      const claimRepo = buildClaimRepo();
      const delivery = buildDelivery(true);
      const jobRepo = buildJobRepo();

      const service = new ReportOrchestrationService(
        claimRepo,
        delivery,
        jobRepo,
        buildScheduleService(),
        buildConfig(),
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
  });
});
