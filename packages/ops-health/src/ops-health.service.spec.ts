/* eslint-disable @typescript-eslint/unbound-method -- Jest mock method assertions */
import { ConfigService } from '@nestjs/config';
import { OpsHealthService } from './ops-health.service';
import type { OpsHealthRepositoryPort } from './types';

function mockRepository(
  overrides?: Partial<OpsHealthRepositoryPort>,
): OpsHealthRepositoryPort {
  return {
    getChatQuotaSummary: jest.fn().mockResolvedValue({ stuckReserved: 0 }),
    getStudyReminderSummary: jest
      .fn()
      .mockResolvedValue({ terminalFailedSince: 0, stuckProcessing: 0 }),
    getLlmSafetyWarningsCount: jest.fn().mockResolvedValue(0),
    ...overrides,
  };
}

function mockConfig(values: Record<string, string> = {}): ConfigService {
  return {
    get: (key: string) => values[key],
  } as unknown as ConfigService;
}

describe('OpsHealthService', () => {
  describe('isEnabled', () => {
    it('returns true by default (no env set)', () => {
      const service = new OpsHealthService(mockRepository(), mockConfig());
      expect(service.isEnabled()).toBe(true);
    });

    it('returns false when explicitly disabled', () => {
      const service = new OpsHealthService(
        mockRepository(),
        mockConfig({ OPS_HEALTH_ALERT_ENABLED: 'false' }),
      );
      expect(service.isEnabled()).toBe(false);
    });

    it('returns false for "0"', () => {
      const service = new OpsHealthService(
        mockRepository(),
        mockConfig({ OPS_HEALTH_ALERT_ENABLED: '0' }),
      );
      expect(service.isEnabled()).toBe(false);
    });

    it('returns true for "true"', () => {
      const service = new OpsHealthService(
        mockRepository(),
        mockConfig({ OPS_HEALTH_ALERT_ENABLED: 'true' }),
      );
      expect(service.isEnabled()).toBe(true);
    });
  });

  describe('collectSnapshot', () => {
    it('returns snapshot with no alerts when all healthy', async () => {
      const repo = mockRepository();
      const service = new OpsHealthService(repo, mockConfig());

      const snapshot = await service.collectSnapshot();

      expect(snapshot.alerts).toHaveLength(0);
      expect(snapshot.generatedAt).toBeDefined();
      expect(snapshot.llmSafetyThresholdBreached).toBe(false);
    });

    it('generates alert when terminal failed jobs exceed threshold', async () => {
      const repo = mockRepository({
        getStudyReminderSummary: jest
          .fn()
          .mockResolvedValue({ terminalFailedSince: 3, stuckProcessing: 0 }),
      });
      const service = new OpsHealthService(repo, mockConfig());

      const snapshot = await service.collectSnapshot();

      expect(snapshot.alerts).toHaveLength(1);
      expect(snapshot.alerts[0].code).toBe('STUDY_REMINDER_TERMINAL_FAILED');
    });

    it('generates alert when stuck processing jobs exist', async () => {
      const repo = mockRepository({
        getStudyReminderSummary: jest
          .fn()
          .mockResolvedValue({ terminalFailedSince: 0, stuckProcessing: 2 }),
      });
      const service = new OpsHealthService(repo, mockConfig());

      const snapshot = await service.collectSnapshot();

      expect(snapshot.alerts).toHaveLength(1);
      expect(snapshot.alerts[0].code).toBe('STUDY_REMINDER_STUCK_PROCESSING');
    });

    it('generates alert when stuck reserved idempotency rows exist', async () => {
      const repo = mockRepository({
        getChatQuotaSummary: jest.fn().mockResolvedValue({ stuckReserved: 5 }),
      });
      const service = new OpsHealthService(repo, mockConfig());

      const snapshot = await service.collectSnapshot();

      expect(snapshot.alerts).toHaveLength(1);
      expect(snapshot.alerts[0].code).toBe('CHAT_QUOTA_STUCK_RESERVED');
    });

    it('generates alert when LLM safety warnings exceed threshold', async () => {
      const repo = mockRepository({
        getLlmSafetyWarningsCount: jest.fn().mockResolvedValue(10),
      });
      const service = new OpsHealthService(repo, mockConfig());

      const snapshot = await service.collectSnapshot();

      expect(snapshot.alerts).toHaveLength(1);
      expect(snapshot.alerts[0].code).toBe('LLM_SAFETY_WARNING_THRESHOLD');
      expect(snapshot.llmSafetyThresholdBreached).toBe(true);
    });

    it('generates multiple alerts when multiple issues exist', async () => {
      const repo = mockRepository({
        getStudyReminderSummary: jest
          .fn()
          .mockResolvedValue({ terminalFailedSince: 5, stuckProcessing: 3 }),
        getChatQuotaSummary: jest.fn().mockResolvedValue({ stuckReserved: 2 }),
        getLlmSafetyWarningsCount: jest.fn().mockResolvedValue(8),
      });
      const service = new OpsHealthService(repo, mockConfig());

      const snapshot = await service.collectSnapshot();

      expect(snapshot.alerts.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('logSnapshotIfNeeded', () => {
    it('skips when disabled', async () => {
      const repo = mockRepository();
      const service = new OpsHealthService(
        repo,
        mockConfig({ OPS_HEALTH_ALERT_ENABLED: 'false' }),
      );

      await service.logSnapshotIfNeeded();

      expect(repo.getChatQuotaSummary).not.toHaveBeenCalled();
    });
  });
});
