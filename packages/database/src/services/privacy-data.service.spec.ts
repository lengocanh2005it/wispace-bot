import { DataSource, Repository } from 'typeorm';
import {
  PrivacyDataService,
  type ChatHistoryClearer,
} from './privacy-data.service';

describe('PrivacyDataService', () => {
  let service: PrivacyDataService;
  let mockDataSource: jest.Mocked<DataSource>;
  let mockManager: jest.Mocked<unknown>;
  let mockMappingRepo: jest.Mocked<Repository<unknown>>;
  let mockLearnerRepo: jest.Mocked<Repository<unknown>>;
  let mockReminderRepo: jest.Mocked<Repository<unknown>>;
  let mockClaimRepo: jest.Mocked<Repository<unknown>>;
  let mockReportRepo: jest.Mocked<Repository<unknown>>;
  let mockLogRepo: jest.Mocked<Repository<unknown>>;
  let mockDailyUsageRepo: jest.Mocked<Repository<unknown>>;
  let mockLlmUsageRepo: jest.Mocked<Repository<unknown>>;
  let mockIdempotencyRepo: jest.Mocked<Repository<unknown>>;
  let mockDiscordMappingRepo: jest.Mocked<Repository<unknown>>;
  let mockZaloMappingRepo: jest.Mocked<Repository<unknown>>;

  const makeRepo = () =>
    ({
      findOne: jest.fn(),
      remove: jest.fn(),
      count: jest.fn(),
      delete: jest.fn(),
    }) as unknown as jest.Mocked<Repository<unknown>>;

  beforeEach(() => {
    mockMappingRepo = makeRepo();
    mockLearnerRepo = makeRepo();
    mockReminderRepo = makeRepo();
    mockClaimRepo = makeRepo();
    mockReportRepo = makeRepo();
    mockLogRepo = makeRepo();
    mockDailyUsageRepo = makeRepo();
    mockLlmUsageRepo = makeRepo();
    mockIdempotencyRepo = makeRepo();
    mockDiscordMappingRepo = makeRepo();
    mockZaloMappingRepo = makeRepo();

    mockManager = {
      getRepository: jest.fn().mockImplementation((entityName: string) => {
        switch (entityName) {
          case 'UserPlatformMapping':
            return mockMappingRepo;
          case 'DiscordAccountLink':
            return mockDiscordMappingRepo;
          case 'ZaloAccountLink':
            return mockZaloMappingRepo;
          case 'LearnerProfile':
            return mockLearnerRepo;
          case 'StudyReminderJob':
            return mockReminderRepo;
          case 'ScheduledReportClaim':
            return mockClaimRepo;
          case 'ReportSendJob':
            return mockReportRepo;
          case 'ChatDailyUsage':
            return mockDailyUsageRepo;
          case 'LlmUsageEvent':
            return mockLlmUsageRepo;
          case 'ChatIdempotency':
            return mockIdempotencyRepo;
          default:
            throw new Error(`Unknown entity: ${entityName}`);
        }
      }),
    };

    mockDataSource = {
      getRepository: jest.fn().mockImplementation((entityName: string) => {
        switch (entityName) {
          case 'UserPlatformMapping':
          case 'DiscordAccountLink':
          case 'ZaloAccountLink':
            return mockMappingRepo;
          case 'LearnerProfile':
            return mockLearnerRepo;
          case 'StudyReminderJob':
            return mockReminderRepo;
          case 'ScheduledReportClaim':
            return mockClaimRepo;
          case 'ReportSendJob':
            return mockReportRepo;
          case 'MessageLog':
            return mockLogRepo;
          case 'ChatDailyUsage':
            return mockDailyUsageRepo;
          case 'LlmUsageEvent':
            return mockLlmUsageRepo;
          case 'ChatIdempotency':
            return mockIdempotencyRepo;
          default:
            throw new Error(`Unknown entity: ${entityName}`);
        }
      }),
      transaction: jest.fn().mockImplementation(async (fn) => fn(mockManager)),
    } as unknown as jest.Mocked<DataSource>;

    service = new PrivacyDataService(mockDataSource);
  });

  describe('unlink', () => {
    it('returns deleted:false when no mapping exists', async () => {
      mockMappingRepo.findOne.mockResolvedValue(null);

      const result = await service.unlink('messenger', 'psid-123');

      expect(result).toEqual({ deleted: false });
      expect(mockMappingRepo.findOne).toHaveBeenCalledWith({
        where: { platform: 'messenger', externalUserId: 'psid-123' },
      });
    });

    it('deletes mapping and returns userId when mapping exists', async () => {
      const mockMapping = { id: 1, userId: 42, platform: 'messenger' };
      mockMappingRepo.findOne.mockResolvedValue(mockMapping);
      mockMappingRepo.remove.mockResolvedValue(mockMapping);

      const result = await service.unlink('messenger', 'psid-123');

      expect(result).toEqual({ deleted: true, userId: 42 });
      expect(mockMappingRepo.remove).toHaveBeenCalledWith(mockMapping);
    });

    it('is idempotent - calling twice returns deleted:false second time', async () => {
      const mockMapping = { id: 1, userId: 42, platform: 'messenger' };
      mockMappingRepo.findOne
        .mockResolvedValueOnce(mockMapping)
        .mockResolvedValueOnce(null);
      mockMappingRepo.remove.mockResolvedValue(mockMapping);

      const first = await service.unlink('messenger', 'psid-123');
      const second = await service.unlink('messenger', 'psid-123');

      expect(first.deleted).toBe(true);
      expect(second.deleted).toBe(false);
    });
  });

  describe('delete', () => {
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
      expect(mockReportRepo.delete).toHaveBeenCalledWith({ userId: 42 });
      expect(mockDailyUsageRepo.delete).toHaveBeenCalledWith({ userId: 42 });
      expect(mockLlmUsageRepo.delete).toHaveBeenCalledWith({ userId: 42 });
      expect(mockIdempotencyRepo.delete).toHaveBeenCalledWith({ userId: 42 });
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

    it('clears Redis chat history when ChatHistoryClearer provided', async () => {
      const mockClearer: jest.Mocked<ChatHistoryClearer> = {
        clear: jest.fn().mockResolvedValue(undefined),
      };
      const serviceWithRedis = new PrivacyDataService(
        mockDataSource,
        mockClearer,
      );

      mockMappingRepo.findOne.mockResolvedValue(null);
      mockLearnerRepo.delete.mockResolvedValue({ affected: 0 } as never);
      mockReminderRepo.delete.mockResolvedValue({ affected: 0 } as never);
      mockClaimRepo.delete.mockResolvedValue({ affected: 0 } as never);
      mockReportRepo.delete.mockResolvedValue({ affected: 0 } as never);
      mockDailyUsageRepo.delete.mockResolvedValue({ affected: 0 } as never);
      mockLlmUsageRepo.delete.mockResolvedValue({ affected: 0 } as never);
      mockIdempotencyRepo.delete.mockResolvedValue({ affected: 0 } as never);

      await serviceWithRedis.delete('messenger', 'psid-123');

      expect(mockClearer.clear).toHaveBeenCalledWith('psid-123');
    });

    it('skips Redis cleanup when no ChatHistoryClearer provided', async () => {
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

    it('works for discord platform', async () => {
      mockMappingRepo.findOne.mockResolvedValue(null);
      mockLearnerRepo.findOne.mockResolvedValue(null);
      mockReminderRepo.count.mockResolvedValue(0);
      mockClaimRepo.count.mockResolvedValue(0);
      mockReportRepo.count.mockResolvedValue(0);
      mockLogRepo.count.mockResolvedValue(0);

      const result = await service.export('discord', 'discord-123');

      expect(result.platform).toBe('discord');
      expect(result.externalUserId).toBe('discord-123');
    });

    it('works for zalo platform', async () => {
      mockMappingRepo.findOne.mockResolvedValue(null);
      mockLearnerRepo.findOne.mockResolvedValue(null);
      mockReminderRepo.count.mockResolvedValue(0);
      mockClaimRepo.count.mockResolvedValue(0);
      mockReportRepo.count.mockResolvedValue(0);
      mockLogRepo.count.mockResolvedValue(0);

      const result = await service.export('zalo', 'zalo-123');

      expect(result.platform).toBe('zalo');
      expect(result.externalUserId).toBe('zalo-123');
    });
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
