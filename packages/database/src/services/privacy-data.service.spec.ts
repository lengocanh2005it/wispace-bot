import { createHash } from 'crypto';
import { DataSource, ObjectLiteral, Repository } from 'typeorm';
import {
  PrivacyDataService,
  type PrivacyEntityRegistry,
} from './privacy-data.service';
import type {
  PrivacyCleanupJobStatus,
  PrivacyCleanupJobStore,
} from './privacy-cleanup-job.service';

class MessengerMappingTarget {}
class DiscordMappingTarget {}
class ZaloMappingTarget {}
class LearnerProfileTarget {}
class StudyReminderTarget {}
class ScheduledReportClaimTarget {}
class LearnerScheduledReportClaimTarget {}
class ReportSendJobTarget {}
class ChatDailyUsageTarget {}
class LlmUsageEventTarget {}
class ChatIdempotencyTarget {}
class WebActivityTarget {}
class NotificationPreferenceTarget {}
class MessageLogTarget {}

describe('PrivacyDataService', () => {
  let service: PrivacyDataService;
  let mockDataSource: jest.Mocked<DataSource>;
  let mockManager: jest.Mocked<unknown>;
  let mockMappingRepo: jest.Mocked<Repository<ObjectLiteral>>;
  let mockLearnerRepo: jest.Mocked<Repository<ObjectLiteral>>;
  let mockReminderRepo: jest.Mocked<Repository<ObjectLiteral>>;
  let mockClaimRepo: jest.Mocked<Repository<ObjectLiteral>>;
  let mockLearnerClaimRepo: jest.Mocked<Repository<ObjectLiteral>>;
  let mockReportRepo: jest.Mocked<Repository<ObjectLiteral>>;
  let mockLogRepo: jest.Mocked<Repository<ObjectLiteral>>;
  let mockDailyUsageRepo: jest.Mocked<Repository<ObjectLiteral>>;
  let mockLlmUsageRepo: jest.Mocked<Repository<ObjectLiteral>>;
  let mockIdempotencyRepo: jest.Mocked<Repository<ObjectLiteral>>;
  let mockNotificationPrefRepo: jest.Mocked<Repository<ObjectLiteral>>;
  let mockDiscordMappingRepo: jest.Mocked<Repository<ObjectLiteral>>;
  let mockWebActivityRepo: jest.Mocked<Repository<ObjectLiteral>>;
  let mockZaloMappingRepo: jest.Mocked<Repository<ObjectLiteral>>;
  let mockManagerQuery: jest.Mock;

  const targets = {
    messenger: MessengerMappingTarget,
    discord: DiscordMappingTarget,
    zalo: ZaloMappingTarget,
    learnerProfile: LearnerProfileTarget,
    studyReminderJob: StudyReminderTarget,
    scheduledReportClaim: ScheduledReportClaimTarget,
    learnerScheduledReportClaim: LearnerScheduledReportClaimTarget,
    reportSendJob: ReportSendJobTarget,
    chatDailyUsage: ChatDailyUsageTarget,
    llmUsageEvent: LlmUsageEventTarget,
    chatIdempotency: ChatIdempotencyTarget,
    webActivity: WebActivityTarget,
    notificationPreference: NotificationPreferenceTarget,
    messageLog: MessageLogTarget,
  } as const;

  const makeRegistry = (
    platform: PrivacyEntityRegistry['platform'] = 'messenger',
    overrides: Partial<PrivacyEntityRegistry> = {},
  ): PrivacyEntityRegistry => ({
    platform,
    mappings: {
      messenger: targets.messenger,
      discord: targets.discord,
      zalo: targets.zalo,
    },
    scoped: {
      learnerProfile: targets.learnerProfile,
      studyReminderJob: targets.studyReminderJob,
      scheduledReportClaim: targets.scheduledReportClaim,
      learnerScheduledReportClaim: targets.learnerScheduledReportClaim,
      reportSendJob: targets.reportSendJob,
      chatDailyUsage: targets.chatDailyUsage,
      llmUsageEvent: targets.llmUsageEvent,
      chatIdempotency: targets.chatIdempotency,
      webActivity: targets.webActivity,
      notificationPreference: targets.notificationPreference,
    },
    messageLog: targets.messageLog,
    ...overrides,
  });

  // `find` is part of the contract the service relies on for the
  // cross-platform fan-out (#461); a fake without it silently skips that
  // branch instead of exercising it.
  const makeRepo = () =>
    ({
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      remove: jest.fn(),
      count: jest.fn(),
      delete: jest.fn(),
    }) as unknown as jest.Mocked<Repository<ObjectLiteral>>;

  beforeEach(() => {
    mockMappingRepo = makeRepo();
    mockLearnerRepo = makeRepo();
    mockReminderRepo = makeRepo();
    mockClaimRepo = makeRepo();
    mockLearnerClaimRepo = makeRepo();
    mockReportRepo = makeRepo();
    mockLogRepo = makeRepo();
    mockDailyUsageRepo = makeRepo();
    mockLlmUsageRepo = makeRepo();
    mockIdempotencyRepo = makeRepo();
    mockNotificationPrefRepo = makeRepo();
    mockDiscordMappingRepo = makeRepo();
    mockWebActivityRepo = makeRepo();
    mockZaloMappingRepo = makeRepo();

    mockManagerQuery = jest.fn().mockResolvedValue([]);
    const repoByTarget = new Map<unknown, Repository<ObjectLiteral>>([
      [targets.messenger, mockMappingRepo],
      [targets.discord, mockDiscordMappingRepo],
      [targets.zalo, mockZaloMappingRepo],
      [targets.learnerProfile, mockLearnerRepo],
      [targets.studyReminderJob, mockReminderRepo],
      [targets.scheduledReportClaim, mockClaimRepo],
      [targets.learnerScheduledReportClaim, mockLearnerClaimRepo],
      [targets.reportSendJob, mockReportRepo],
      [targets.chatDailyUsage, mockDailyUsageRepo],
      [targets.llmUsageEvent, mockLlmUsageRepo],
      [targets.chatIdempotency, mockIdempotencyRepo],
      [targets.webActivity, mockWebActivityRepo],
      [targets.notificationPreference, mockNotificationPrefRepo],
      [targets.messageLog, mockLogRepo],
    ]);
    mockManager = {
      query: mockManagerQuery,
      getRepository: jest.fn().mockImplementation((target: unknown) => {
        const repo = repoByTarget.get(target);
        if (!repo) throw new Error(`Unknown entity target: ${String(target)}`);
        return repo;
      }),
    };

    mockDataSource = {
      hasMetadata: jest.fn().mockReturnValue(true),
      query: jest.fn().mockResolvedValue([]),
      getRepository: jest.fn().mockImplementation((target: unknown) => {
        const repo = repoByTarget.get(target);
        if (!repo) throw new Error(`Unknown entity target: ${String(target)}`);
        return repo;
      }),
      transaction: jest.fn().mockImplementation(async (fn) => fn(mockManager)),
    } as unknown as jest.Mocked<DataSource>;

    service = new PrivacyDataService(mockDataSource, makeRegistry());
  });

  describe('constructor', () => {
    it('fails fast with every required entity missing from TypeORM metadata', () => {
      mockDataSource.hasMetadata.mockImplementation(
        (target) => target !== targets.webActivity,
      );

      expect(
        () => new PrivacyDataService(mockDataSource, makeRegistry()),
      ).toThrow(/scoped\.webActivity.*WebActivityTarget/);
    });

    it('fails fast when a scoped target is omitted from the registry', () => {
      const registry = makeRegistry();
      delete (registry.scoped as Partial<PrivacyEntityRegistry['scoped']>)[
        'webActivity'
      ];

      expect(() => new PrivacyDataService(mockDataSource, registry)).toThrow(
        /scoped\.webActivity \(missing\)/,
      );
    });
  });

  describe('unlink', () => {
    it('returns an explicit incomplete outcome after independently bounded cleanup attempts', async () => {
      mockMappingRepo.findOne.mockResolvedValue({
        id: 1,
        userId: 42,
        platform: 'messenger',
        externalUserId: 'psid-123',
        mappingGeneration: '3',
      });
      const clearHistory = jest.fn().mockRejectedValue(new Error('redis down'));

      const result = await service.unlink('messenger', 'psid-123', {
        platform: 'messenger',
        applicableStores: ['chat_history'],
        clearHistory,
      });

      expect(result.status).toBe('incomplete');
      expect(result.outstandingStores).toEqual(['chat_history']);
      expect(result.cleanupId).toEqual(expect.any(String));
      expect(clearHistory).toHaveBeenCalledTimes(3);
    });

    it('returns deleted:false when no mapping exists', async () => {
      mockMappingRepo.findOne.mockResolvedValue(null);

      const result = await service.unlink('messenger', 'psid-123');

      expect(result).toEqual({ deleted: false });
      expect(mockMappingRepo.findOne).toHaveBeenCalledWith({
        where: { platform: 'messenger', externalUserId: 'psid-123' },
      });
    });

    it('fences request-time cleanup when a newer active owner appears', async () => {
      const mapping = {
        id: 1,
        userId: 42,
        platform: 'messenger',
        externalUserId: 'psid-123',
        mappingGeneration: '3',
      };
      mockMappingRepo.findOne.mockResolvedValue(mapping);
      mockDataSource.query = jest
        .fn()
        .mockResolvedValue([{ mapping_generation: '4', link_state: 'active' }]);
      const clearHistory = jest.fn().mockResolvedValue(undefined);
      const cleanupRows = [
        {
          cleanupId: 'cleanup-1',
          idempotencyKey: 'cleanup-1:chat_history',
          store: 'chat_history' as const,
          operation: 'unlink' as const,
          platform: 'messenger' as const,
          externalUserId: 'psid-123',
          mappingGeneration: '4',
          status: 'pending' as PrivacyCleanupJobStatus,
          attemptCount: 0,
        },
      ];
      const cleanupJobs = {
        enqueue: jest.fn().mockResolvedValue([
          {
            cleanupId: 'cleanup-1',
            idempotencyKey: 'cleanup-1:chat_history',
            store: 'chat_history',
          },
        ]),
        getByCleanupId: jest.fn().mockImplementation(async () => cleanupRows),
        markStale: jest.fn().mockImplementation(async () => {
          cleanupRows[0].status = 'stale';
        }),
        markCompleted: jest.fn(),
        markFailure: jest.fn(),
      } as unknown as PrivacyCleanupJobStore;
      const fencedService = new PrivacyDataService(
        mockDataSource,
        makeRegistry(),
        cleanupJobs,
      );

      await expect(
        fencedService.unlink('messenger', 'psid-123', {
          platform: 'messenger',
          applicableStores: ['chat_history'],
          clearHistory,
        }),
      ).resolves.toMatchObject({ status: 'complete' });
      expect(clearHistory).not.toHaveBeenCalled();
      expect(cleanupJobs.markStale).toHaveBeenCalledWith(
        expect.objectContaining({ idempotencyKey: 'cleanup-1:chat_history' }),
      );
    });

    it('deletes mapping and returns userId when mapping exists', async () => {
      const mockMapping = { id: 1, userId: 42, platform: 'messenger' };
      mockMappingRepo.findOne.mockResolvedValue(mockMapping);
      mockMappingRepo.remove.mockResolvedValue(mockMapping);

      const result = await service.unlink('messenger', 'psid-123');

      expect(result).toEqual({ deleted: true, userId: 42 });
      expect(mockDataSource.transaction).toHaveBeenCalled();
      expect(mockMappingRepo.remove).not.toHaveBeenCalled();
    });

    it('invalidates local state and preserves a generation fence', async () => {
      const mockMapping = {
        id: 1,
        userId: 42,
        platform: 'discord',
        externalUserId: 'discord-1',
        mappingGeneration: '7',
      };
      mockDiscordMappingRepo.findOne.mockResolvedValue(mockMapping);
      const serviceWithCleanup = new PrivacyDataService(
        mockDataSource,
        makeRegistry('discord'),
      );

      await serviceWithCleanup.unlink('discord', 'discord-1');

      expect(mockManagerQuery).toHaveBeenCalledWith(
        expect.stringContaining("link_state = 'locally-unlinked'"),
        ['discord', 'discord-1', '8'],
      );
      expect(mockManagerQuery).toHaveBeenCalledWith(
        expect.stringContaining('discord_link_verify_records'),
        ['discord-1'],
      );
      expect(mockManagerQuery).not.toHaveBeenCalledWith(
        expect.stringContaining('learner_scheduled_report_claims'),
        expect.anything(),
      );
      expect(mockMappingRepo.remove).not.toHaveBeenCalled();
    });

    it('does not unlink after the expected mapping changes before the transaction', async () => {
      mockMappingRepo.findOne
        .mockResolvedValueOnce({
          userId: 42,
          platform: 'messenger',
          externalUserId: 'psid-123',
          mappingGeneration: '3',
        })
        .mockResolvedValueOnce({
          userId: 43,
          platform: 'messenger',
          externalUserId: 'psid-123',
          mappingGeneration: '4',
        });

      const result = await service.unlink('messenger', 'psid-123', undefined, {
        exists: true,
        userId: 42,
        mappingGeneration: '3',
      });

      expect(result).toEqual({ deleted: false, conflict: true });
      expect(mockManagerQuery).toHaveBeenCalledWith(
        expect.stringContaining('pg_advisory_xact_lock'),
        [expect.stringContaining('study-reminder:ownership:messenger:')],
      );
    });

    it('clears user cache via per-call cleanup when mapping has a userId', async () => {
      const mockMapping = {
        id: 1,
        userId: 42,
        platform: 'messenger',
        externalUserId: 'psid-123',
        mappingGeneration: '3',
      };
      mockMappingRepo.findOne.mockResolvedValue(mockMapping);
      const clearUserCache = jest.fn().mockResolvedValue(undefined);

      await service.unlink('messenger', 'psid-123', { clearUserCache });

      expect(clearUserCache).toHaveBeenCalledWith(42);
    });

    it('does not call clearUserCache when mapping has no userId', async () => {
      mockMappingRepo.findOne.mockResolvedValue({
        id: 1,
        platform: 'messenger',
        externalUserId: 'psid-123',
      });
      const clearUserCache = jest.fn().mockResolvedValue(undefined);

      await service.unlink('messenger', 'psid-123', { clearUserCache });

      expect(clearUserCache).not.toHaveBeenCalled();
    });

    it('is idempotent - calling twice returns deleted:false second time', async () => {
      const mockMapping = { id: 1, userId: 42, platform: 'messenger' };
      mockMappingRepo.findOne
        .mockResolvedValueOnce(mockMapping)
        .mockResolvedValueOnce(mockMapping)
        .mockResolvedValueOnce(null);
      mockMappingRepo.findOne.mockResolvedValueOnce(null);
      mockMappingRepo.remove.mockResolvedValue(mockMapping);

      const first = await service.unlink('messenger', 'psid-123');
      const second = await service.unlink('messenger', 'psid-123');

      expect(first.deleted).toBe(true);
      expect(second.deleted).toBe(false);
    });

    it('does not advance an existing local-unlink tombstone', async () => {
      mockDiscordMappingRepo.findOne.mockResolvedValue({
        id: 1,
        userId: 42,
        platform: 'discord',
        externalUserId: 'discord-1',
        linkState: 'locally-unlinked',
        mappingGeneration: '8',
      });

      const discordService = new PrivacyDataService(
        mockDataSource,
        makeRegistry('discord'),
      );
      await expect(
        discordService.unlink('discord', 'discord-1'),
      ).resolves.toEqual({
        deleted: false,
        userId: 42,
      });
      expect(mockDataSource.transaction).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('does not delete when the expected mapping no longer matches', async () => {
      mockMappingRepo.findOne.mockResolvedValue({
        userId: 43,
        platform: 'messenger',
        externalUserId: 'psid-123',
        mappingGeneration: '4',
      });

      const result = await service.delete('messenger', 'psid-123', undefined, {
        exists: true,
        userId: 42,
        mappingGeneration: '3',
      });

      expect(result).toBe(false);
      expect(mockMappingRepo.remove).not.toHaveBeenCalled();
      expect(mockLearnerRepo.delete).not.toHaveBeenCalled();
    });

    it('cascades delete across all related tables in a transaction', async () => {
      const mockMapping = { id: 1, userId: 42, platform: 'messenger' };
      mockMappingRepo.findOne.mockResolvedValue(mockMapping);
      mockMappingRepo.remove.mockResolvedValue(mockMapping);
      mockLearnerRepo.delete.mockResolvedValue({ affected: 1 } as never);
      mockReminderRepo.delete.mockResolvedValue({ affected: 2 } as never);
      mockClaimRepo.delete.mockResolvedValue({ affected: 1 } as never);
      mockReportRepo.delete.mockResolvedValue({ affected: 0 } as never);
      mockDailyUsageRepo.delete.mockResolvedValue({ affected: 5 } as never);
      mockLlmUsageRepo.delete.mockResolvedValue({ affected: 10 } as never);
      mockIdempotencyRepo.delete.mockResolvedValue({ affected: 3 } as never);
      mockDiscordMappingRepo.delete.mockResolvedValue({
        affected: 1,
      } as never);

      await service.delete('messenger', 'psid-123');

      // Transaction was used
      expect(mockDataSource.transaction).toHaveBeenCalled();

      // Mapping removed (unlink)
      expect(mockMappingRepo.remove).toHaveBeenCalled();

      // Cross-platform: Discord mapping deleted by userId
      expect(mockDiscordMappingRepo.delete).toHaveBeenCalledWith({
        userId: 42,
      });

      // All user data deleted by userId
      expect(mockLearnerRepo.delete).toHaveBeenCalledWith({ userId: 42 });
      expect(mockReminderRepo.delete).toHaveBeenCalledWith({ userId: 42 });
      expect(mockClaimRepo.delete).toHaveBeenCalledWith({ userId: 42 });
      expect(mockLearnerClaimRepo.delete).toHaveBeenCalledWith({ userId: 42 });
      expect(mockReportRepo.delete).toHaveBeenCalledWith({ userId: 42 });
      expect(mockDailyUsageRepo.delete).toHaveBeenCalledWith({ userId: 42 });
      expect(mockLlmUsageRepo.delete).toHaveBeenCalledWith({ userId: 42 });
      expect(mockIdempotencyRepo.delete).toHaveBeenCalledWith({ userId: 42 });
      expect(mockWebActivityRepo.delete).toHaveBeenCalledWith({ userId: 42 });
      expect(mockNotificationPrefRepo.delete).toHaveBeenCalledWith({
        userId: 42,
      });
    });

    it('erases only the anonymous usage bucket when the mapping has no userId (#1177)', async () => {
      const mockMapping = {
        id: 1,
        userId: null,
        platform: 'messenger',
        externalUserId: 'psid-123',
      };
      mockMappingRepo.findOne.mockResolvedValue(mockMapping);
      mockMappingRepo.remove.mockResolvedValue(mockMapping);
      mockDailyUsageRepo.delete.mockResolvedValue({ affected: 1 } as never);
      mockLlmUsageRepo.delete.mockResolvedValue({ affected: 1 } as never);

      await service.delete('messenger', 'psid-123');

      const usageDelete = mockDailyUsageRepo.delete.mock.calls[0]?.[0] as {
        platform?: string;
        externalUserId?: string;
        userId?: { _type?: string };
      };

      // A learner row for the same channel/date belongs to another learner and
      // must survive a channel-scoped erasure.
      expect(usageDelete.platform).toBe('messenger');
      expect(usageDelete.externalUserId).toBe('psid-123');
      expect(usageDelete.userId?._type).toBe('isNull');

      // Other channel-scoped stores keep their plain (platform, externalUserId)
      // fallback.
      expect(mockLlmUsageRepo.delete).toHaveBeenCalledWith({
        platform: 'messenger',
        externalUserId: 'psid-123',
      });
    });

    // Regression for #461: the cross-platform fan-out was previously guarded
    // by `if (find)`, so a fake repo without `find` skipped it silently and no
    // test covered the branch. Asserts the outcomes for a DISTINCT external id
    // on another platform, which is what the fan-out exists to reach.
    it('fans out to another platform: audits, cancels work, deletes verify intent and clears its distinct external id', async () => {
      const mockMapping = { id: 1, userId: 42, platform: 'messenger' };
      mockMappingRepo.findOne.mockResolvedValue(mockMapping);
      mockMappingRepo.remove.mockResolvedValue(mockMapping);
      // Same learner, linked on Discord under a different external id.
      mockDiscordMappingRepo.find.mockResolvedValue([
        {
          externalUserId: 'discord-user-9',
          userId: 42,
          mappingGeneration: 'gen-7',
        },
      ]);
      mockDiscordMappingRepo.delete.mockResolvedValue({ affected: 1 } as never);
      const clearHistory = jest.fn().mockResolvedValue(undefined);

      await service.delete('messenger', 'psid-123', { clearHistory });

      expect(mockDiscordMappingRepo.find).toHaveBeenCalledWith({
        where: { userId: 42 },
      });

      // Audit row is written for the OTHER platform, keyed by the hash of its
      // own external id — not the messenger one.
      expect(mockManagerQuery).toHaveBeenCalledWith(
        expect.stringContaining('platform_link_audit_events'),
        [
          'discord',
          createHash('sha256').update('discord-user-9').digest('hex'),
          'gen-7',
        ],
      );

      // Queued reminder work for that identity is cancelled.
      expect(mockManagerQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE study_reminder_jobs'),
        ['discord', 'discord-user-9'],
      );

      // Pending verify intent on that platform is removed.
      expect(mockManagerQuery).toHaveBeenCalledWith(
        expect.stringContaining('discord_link_verify_records'),
        ['discord-user-9'],
      );

      // Redis-side state is cleared for BOTH identities via per-call callbacks.
      // Each bot clears its own platform's keys; cross-platform erasure
      // requires the backend to call each bot's /privacy/delete endpoint.
      expect(clearHistory).toHaveBeenCalledWith('psid-123');
      expect(clearHistory).toHaveBeenCalledWith('discord-user-9');
    });

    it('does not attempt web_activity deletion when mapping has no userId', async () => {
      const mockMapping = { id: 1, userId: undefined, platform: 'messenger' };
      mockMappingRepo.findOne.mockResolvedValue(mockMapping);
      mockMappingRepo.remove.mockResolvedValue(mockMapping);
      mockLearnerRepo.delete.mockResolvedValue({ affected: 0 } as never);
      mockReminderRepo.delete.mockResolvedValue({ affected: 0 } as never);
      mockClaimRepo.delete.mockResolvedValue({ affected: 0 } as never);
      mockReportRepo.delete.mockResolvedValue({ affected: 0 } as never);
      mockDailyUsageRepo.delete.mockResolvedValue({ affected: 0 } as never);
      mockLlmUsageRepo.delete.mockResolvedValue({ affected: 0 } as never);
      mockIdempotencyRepo.delete.mockResolvedValue({ affected: 0 } as never);

      await service.delete('messenger', 'psid-123');

      expect(mockWebActivityRepo.delete).not.toHaveBeenCalled();
    });

    it('does not fail when mapping does not exist', async () => {
      mockMappingRepo.findOne.mockResolvedValue(null);
      mockLearnerRepo.delete.mockResolvedValue({ affected: 0 } as never);
      mockReminderRepo.delete.mockResolvedValue({ affected: 0 } as never);
      mockClaimRepo.delete.mockResolvedValue({ affected: 0 } as never);
      mockReportRepo.delete.mockResolvedValue({ affected: 0 } as never);
      mockDailyUsageRepo.delete.mockResolvedValue({ affected: 0 } as never);
      mockLlmUsageRepo.delete.mockResolvedValue({ affected: 0 } as never);
      mockIdempotencyRepo.delete.mockResolvedValue({ affected: 0 } as never);

      await expect(
        service.delete('messenger', 'psid-123'),
      ).resolves.not.toThrow();

      // Transaction still used even when no mapping
      expect(mockDataSource.transaction).toHaveBeenCalled();
    });

    it('reuses an existing tombstone generation for durable delete cleanup', async () => {
      mockMappingRepo.findOne.mockResolvedValue(null);
      for (const repo of [
        mockLearnerRepo,
        mockReminderRepo,
        mockClaimRepo,
        mockReportRepo,
        mockDailyUsageRepo,
        mockLlmUsageRepo,
        mockIdempotencyRepo,
      ]) {
        repo.delete.mockResolvedValue({ affected: 0 } as never);
      }
      mockManagerQuery.mockImplementation(async (sql: string) =>
        sql.includes('FROM platform_link_audit_events')
          ? [{ mapping_generation: '4' }]
          : [],
      );
      mockDataSource.query.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM platform_link_audit_events')) {
          return [{ mapping_generation: '4' }];
        }
        return [];
      });
      const clearHistory = jest.fn().mockResolvedValue(undefined);
      const outcomes: string[] = [];

      const result = await service.delete('messenger', 'psid-123', {
        platform: 'messenger',
        applicableStores: ['chat_history'],
        clearHistory,
        onAttempt: (_store, outcome) => outcomes.push(outcome),
      });

      expect(result).toMatchObject({ status: 'complete' });
      expect(clearHistory).toHaveBeenCalledWith('psid-123');
      expect(outcomes).toContain('success');
    });

    it('rolls back transaction on failure', async () => {
      const mockMapping = { id: 1, userId: 42, platform: 'messenger' };
      mockMappingRepo.findOne.mockResolvedValue(mockMapping);
      mockMappingRepo.remove.mockResolvedValue(mockMapping);
      mockLearnerRepo.delete.mockRejectedValue(new Error('db failure'));

      await expect(service.delete('messenger', 'psid-123')).rejects.toThrow(
        'db failure',
      );

      // Transaction was attempted
      expect(mockDataSource.transaction).toHaveBeenCalled();
    });

    it('clears user cache once via per-call cleanup when mapping has a userId', async () => {
      const mockMapping = { id: 1, userId: 42, platform: 'messenger' };
      mockMappingRepo.findOne.mockResolvedValue(mockMapping);
      mockMappingRepo.remove.mockResolvedValue(mockMapping);
      mockLearnerRepo.delete.mockResolvedValue({ affected: 0 } as never);
      mockReminderRepo.delete.mockResolvedValue({ affected: 0 } as never);
      mockClaimRepo.delete.mockResolvedValue({ affected: 0 } as never);
      mockReportRepo.delete.mockResolvedValue({ affected: 0 } as never);
      mockDailyUsageRepo.delete.mockResolvedValue({ affected: 0 } as never);
      mockLlmUsageRepo.delete.mockResolvedValue({ affected: 0 } as never);
      mockIdempotencyRepo.delete.mockResolvedValue({ affected: 0 } as never);
      const clearUserCache = jest.fn().mockResolvedValue(undefined);

      await service.delete('messenger', 'psid-123', { clearUserCache });

      expect(clearUserCache).toHaveBeenCalledTimes(1);
      expect(clearUserCache).toHaveBeenCalledWith(42);
    });

    it('does not call clearUserCache when no mapping exists', async () => {
      mockMappingRepo.findOne.mockResolvedValue(null);
      mockLearnerRepo.delete.mockResolvedValue({ affected: 0 } as never);
      mockReminderRepo.delete.mockResolvedValue({ affected: 0 } as never);
      mockClaimRepo.delete.mockResolvedValue({ affected: 0 } as never);
      mockReportRepo.delete.mockResolvedValue({ affected: 0 } as never);
      mockDailyUsageRepo.delete.mockResolvedValue({ affected: 0 } as never);
      mockLlmUsageRepo.delete.mockResolvedValue({ affected: 0 } as never);
      mockIdempotencyRepo.delete.mockResolvedValue({ affected: 0 } as never);
      const clearUserCache = jest.fn().mockResolvedValue(undefined);

      await service.delete('messenger', 'psid-123', { clearUserCache });

      expect(clearUserCache).not.toHaveBeenCalled();
    });

    it('skips cleanup entirely when no per-call cleanup provided', async () => {
      mockMappingRepo.findOne.mockResolvedValue(null);
      mockLearnerRepo.delete.mockResolvedValue({ affected: 0 } as never);
      mockReminderRepo.delete.mockResolvedValue({ affected: 0 } as never);
      mockClaimRepo.delete.mockResolvedValue({ affected: 0 } as never);
      mockReportRepo.delete.mockResolvedValue({ affected: 0 } as never);
      mockDailyUsageRepo.delete.mockResolvedValue({ affected: 0 } as never);
      mockLlmUsageRepo.delete.mockResolvedValue({ affected: 0 } as never);
      mockIdempotencyRepo.delete.mockResolvedValue({ affected: 0 } as never);

      // Should not throw — no Redis dependency
      await expect(
        service.delete('messenger', 'psid-123'),
      ).resolves.not.toThrow();
    });
  });

  describe('export', () => {
    it('does not export after the expected mapping changes', async () => {
      mockMappingRepo.findOne.mockResolvedValue({
        userId: 43,
        platform: 'messenger',
        externalUserId: 'psid-123',
        mappingGeneration: '4',
      });

      const result = await service.export('messenger', 'psid-123', {
        exists: true,
        userId: 42,
        mappingGeneration: '3',
      });

      expect(result).toBeNull();
      expect(mockLearnerRepo.findOne).not.toHaveBeenCalled();
    });

    it('returns empty data when no mapping exists', async () => {
      mockMappingRepo.findOne.mockResolvedValue(null);
      mockLearnerRepo.findOne.mockResolvedValue(null);
      mockReminderRepo.count.mockResolvedValue(0);
      mockClaimRepo.count.mockResolvedValue(0);
      mockReportRepo.count.mockResolvedValue(0);
      mockLogRepo.count.mockResolvedValue(0);

      const result = await service.export('messenger', 'psid-123');

      expect(result).toEqual({
        platform: 'messenger',
        externalUserId: 'psid-123',
        linkedAt: undefined,
        studyReminderJobs: 0,
        scheduledReportClaims: 0,
        reportSendJobs: 0,
        messageLogs: 0,
      });
    });

    it('returns full data when mapping and profile exist', async () => {
      const mockMapping = {
        id: 1,
        userId: 42,
        platform: 'messenger',
        createdAt: new Date('2026-01-01'),
      };
      const mockProfile = {
        targetScore: '7.0',
        examDate: '2026-09-01',
        fetchedAt: new Date('2026-08-01'),
      };

      mockMappingRepo.findOne.mockResolvedValue(mockMapping);
      mockLearnerRepo.findOne.mockResolvedValue(mockProfile);
      mockReminderRepo.count.mockResolvedValue(3);
      mockClaimRepo.count.mockResolvedValue(1);
      mockReportRepo.count.mockResolvedValue(2);
      mockLogRepo.count.mockResolvedValue(10);

      const result = await service.export('messenger', 'psid-123');

      expect(result).toEqual({
        platform: 'messenger',
        externalUserId: 'psid-123',
        linkedAt: new Date('2026-01-01'),
        learnerProfile: {
          targetScore: '7.0',
          examDate: '2026-09-01',
          fetchedAt: new Date('2026-08-01'),
        },
        studyReminderJobs: 3,
        scheduledReportClaims: 1,
        reportSendJobs: 2,
        messageLogs: 10,
      });
    });

    // These two previously primed the messenger mapping mock and asserted
    // only the echoed input arguments, so they passed even if export read the
    // wrong platform's repository. Prime that platform's own repo and assert
    // a value that can only have come from it.
    it.each(['discord', 'zalo'] as const)(
      'reads the %s mapping repository on export',
      async (platform) => {
        const platformRepo =
          platform === 'discord' ? mockDiscordMappingRepo : mockZaloMappingRepo;
        const externalUserId = `${platform}-123`;
        const linkedAt = new Date('2026-07-04T00:00:00Z');

        // Only this platform's repo has a mapping; messenger's must not be read.
        platformRepo.findOne.mockResolvedValue({
          id: 1,
          userId: 42,
          platform,
          externalUserId,
          createdAt: linkedAt,
        });
        mockMappingRepo.findOne.mockResolvedValue(null);
        mockLearnerRepo.findOne.mockResolvedValue({
          targetScore: '6.5',
          examDate: '2026-11-30',
          fetchedAt: new Date('2026-07-01'),
        });
        mockReminderRepo.count.mockResolvedValue(2);
        mockClaimRepo.count.mockResolvedValue(1);
        mockReportRepo.count.mockResolvedValue(4);
        mockLogRepo.count.mockResolvedValue(9);

        const platformService = new PrivacyDataService(
          mockDataSource,
          makeRegistry(platform),
        );
        const result = await platformService.export(platform, externalUserId);

        // Queried its own repo, scoped to its own platform.
        expect(platformRepo.findOne).toHaveBeenCalledWith({
          where: { platform, externalUserId },
        });
        expect(mockMappingRepo.findOne).not.toHaveBeenCalled();

        // `linkedAt` can only come from the row that repo returned — the
        // messenger mock returns null, so an assertion on it fails if export
        // read the wrong repository.
        expect(result).toEqual({
          platform,
          externalUserId,
          linkedAt,
          learnerProfile: {
            targetScore: '6.5',
            examDate: '2026-11-30',
            fetchedAt: new Date('2026-07-01'),
          },
          studyReminderJobs: 2,
          scheduledReportClaims: 1,
          reportSendJobs: 4,
          messageLogs: 9,
        });
      },
    );
  });

  describe('getMappingRepo', () => {
    it('throws for unknown platform', async () => {
      mockMappingRepo.findOne.mockResolvedValue(null);

      await expect(service.unlink('unknown', 'user-123')).rejects.toThrow(
        'Unknown platform: unknown',
      );
    });
  });
});
