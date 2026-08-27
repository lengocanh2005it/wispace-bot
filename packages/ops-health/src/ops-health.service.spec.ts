/* eslint-disable @typescript-eslint/unbound-method -- Jest mock method assertions */
import { ConfigService } from '@nestjs/config';
import { OpsHealthService } from './ops-health.service';
import type { OpsHealthRepositoryPort, RedisHealthPort } from './types';
import { CronHeartbeatRegistry } from './cron-heartbeat-registry';

function mockRepository(
  overrides?: Partial<OpsHealthRepositoryPort>,
): OpsHealthRepositoryPort {
  return {
    getChatQuotaSummary: jest.fn().mockResolvedValue({ stuckReserved: 0 }),
    getStudyReminderSummary: jest
      .fn()
      .mockResolvedValue({ terminalFailedSince: 0, stuckProcessing: 0 }),
    getLlmSafetyWarningsCount: jest.fn().mockResolvedValue(0),
    getWebhookInboundSummary: jest.fn().mockResolvedValue({
      pendingCount: 0,
      failedCount: 0,
      stuckProcessingCount: 0,
      oldestPendingAgeSeconds: null,
    }),
    getDeadLetterSummary: jest.fn().mockResolvedValue({
      outboundPendingCount: 0,
      outboundFailedCount: 0,
      oldestPendingAgeSeconds: null,
    }),
    isDatabaseReachable: jest.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function mockRedis(overrides?: Partial<RedisHealthPort>): RedisHealthPort {
  return {
    isConfiguredEnabled: jest.fn().mockReturnValue(true),
    isEnabled: jest.fn().mockReturnValue(true),
    ping: jest.fn().mockResolvedValue('PONG'),
    ...overrides,
  };
}

function mockConfig(values: Record<string, string> = {}): ConfigService {
  return {
    get: (key: string) => values[key],
  } as unknown as ConfigService;
}

describe('OpsHealthService', () => {
  describe('isApplicationReady', () => {
    it('returns ready=true when DB and Redis are reachable and queues are not stuck', async () => {
      const repo = mockRepository();
      const redis = mockRedis();
      const service = new OpsHealthService(
        repo,
        mockConfig(),
        undefined,
        redis,
      );

      const result = await service.isApplicationReady();

      expect(result.ready).toBe(true);
      expect(result.status).toBe('ok');
    });

    it('returns ready=false when DB is unreachable', async () => {
      const repo = mockRepository({
        isDatabaseReachable: jest.fn().mockResolvedValue(false),
      });
      const service = new OpsHealthService(repo, mockConfig());

      const result = await service.isApplicationReady();

      expect(result.ready).toBe(false);
      expect(result.status).toBe('error');
      expect(result.reason).toBe('database_unavailable');
    });

    it('returns ready=false when Redis is configured enabled but not connected', async () => {
      const repo = mockRepository();
      const redis = mockRedis({
        isConfiguredEnabled: jest.fn().mockReturnValue(true),
        isEnabled: jest.fn().mockReturnValue(false),
      });
      const service = new OpsHealthService(
        repo,
        mockConfig(),
        undefined,
        redis,
      );

      const result = await service.isApplicationReady();

      expect(result.ready).toBe(false);
      expect(result.status).toBe('error');
      expect(result.reason).toBe('redis_configured_not_connected');
    });

    it('returns ready=false when Redis ping throws', async () => {
      const repo = mockRepository();
      const redis = mockRedis({
        isConfiguredEnabled: jest.fn().mockReturnValue(true),
        isEnabled: jest.fn().mockReturnValue(true),
        ping: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      });
      const service = new OpsHealthService(
        repo,
        mockConfig(),
        undefined,
        redis,
      );

      const result = await service.isApplicationReady();

      expect(result.ready).toBe(false);
      expect(result.status).toBe('error');
      expect(result.reason).toBe('redis_unreachable');
    });

    it('returns ready=false when webhook inbound queue has severely stuck item', async () => {
      const repo = mockRepository({
        getWebhookInboundSummary: jest.fn().mockResolvedValue({
          pendingCount: 1,
          failedCount: 0,
          stuckProcessingCount: 0,
          oldestPendingAgeSeconds: 900, // > 600s
        }),
      });
      const service = new OpsHealthService(repo, mockConfig());

      const result = await service.isApplicationReady();

      expect(result.ready).toBe(false);
      expect(result.status).toBe('error');
      expect(result.reason).toBe('webhook_inbound_stuck_age_900s');
    });
  });

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
      expect(snapshot.status).toBe('degraded');
    });

    it('generates alert when webhook backlog is high', async () => {
      const repo = mockRepository({
        getWebhookInboundSummary: jest.fn().mockResolvedValue({
          pendingCount: 50, // > 20
          failedCount: 0,
          stuckProcessingCount: 0,
          oldestPendingAgeSeconds: 30,
        }),
      });
      const service = new OpsHealthService(repo, mockConfig());

      const snapshot = await service.collectSnapshot();

      expect(
        snapshot.alerts.some((a) => a.code === 'WEBHOOK_INBOUND_BACKLOG_HIGH'),
      ).toBe(true);
      expect(snapshot.status).toBe('degraded');
    });

    it('generates alert when dead letter backlog is high', async () => {
      const repo = mockRepository({
        getDeadLetterSummary: jest.fn().mockResolvedValue({
          outboundPendingCount: 10, // > 5
          outboundFailedCount: 2,
          oldestPendingAgeSeconds: 120,
        }),
      });
      const service = new OpsHealthService(repo, mockConfig());

      const snapshot = await service.collectSnapshot();

      expect(
        snapshot.alerts.some((a) => a.code === 'DEAD_LETTER_BACKLOG_HIGH'),
      ).toBe(true);
      expect(snapshot.status).toBe('degraded');
    });

    it('generates alert and sets status=error when a registered cron is stale', async () => {
      const repo = mockRepository();
      const registry = new CronHeartbeatRegistry();
      registry.registerCron('stale-cron', 10_000);
      jest.useFakeTimers();
      try {
        registry.recordTick('stale-cron', 10_000, true);
        jest.advanceTimersByTime(30_000); // 30s > 2.5 * 10s

        const service = new OpsHealthService(repo, mockConfig(), registry);
        const snapshot = await service.collectSnapshot();

        expect(
          snapshot.alerts.some((a) => a.code === 'CRON_EXECUTION_STALE'),
        ).toBe(true);
        expect(snapshot.crons?.['stale-cron'].status).toBe('stale');
      } finally {
        jest.useRealTimers();
      }
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
