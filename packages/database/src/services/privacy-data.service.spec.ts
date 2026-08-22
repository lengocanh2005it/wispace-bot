import { DataSource, Repository } from 'typeorm';
import { PrivacyDataService } from './privacy-data.service';

describe('PrivacyDataService', () => {
  let service: PrivacyDataService;
  let mockDataSource: jest.Mocked<DataSource>;
  let mockMappingRepo: jest.Mocked<Repository<unknown>>;
  let mockLearnerRepo: jest.Mocked<Repository<unknown>>;
  let mockReminderRepo: jest.Mocked<Repository<unknown>>;
  let mockClaimRepo: jest.Mocked<Repository<unknown>>;
  let mockReportRepo: jest.Mocked<Repository<unknown>>;
  let mockLogRepo: jest.Mocked<Repository<unknown>>;

  beforeEach(() => {
    mockMappingRepo = {
      findOne: jest.fn(),
      remove: jest.fn(),
      count: jest.fn(),
      delete: jest.fn(),
    } as unknown as jest.Mocked<Repository<unknown>>;

    mockLearnerRepo = {
      findOne: jest.fn(),
      delete: jest.fn(),
    } as unknown as jest.Mocked<Repository<unknown>>;

    mockReminderRepo = {
      count: jest.fn(),
      delete: jest.fn(),
    } as unknown as jest.Mocked<Repository<unknown>>;

    mockClaimRepo = {
      count: jest.fn(),
      delete: jest.fn(),
    } as unknown as jest.Mocked<Repository<unknown>>;

    mockReportRepo = {
      count: jest.fn(),
      delete: jest.fn(),
    } as unknown as jest.Mocked<Repository<unknown>>;

    mockLogRepo = {
      count: jest.fn(),
    } as unknown as jest.Mocked<Repository<unknown>>;

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
          default:
            throw new Error(`Unknown entity: ${entityName}`);
        }
      }),
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
    it('cascades delete across all related tables', async () => {
      const mockMapping = { id: 1, userId: 42, platform: 'messenger' };
      mockMappingRepo.findOne.mockResolvedValue(mockMapping);
      mockMappingRepo.remove.mockResolvedValue(mockMapping);
      mockLearnerRepo.delete.mockResolvedValue({ affected: 1 } as never);
      mockReminderRepo.delete.mockResolvedValue({ affected: 2 } as never);
      mockClaimRepo.delete.mockResolvedValue({ affected: 1 } as never);
      mockReportRepo.delete.mockResolvedValue({ affected: 0 } as never);

      await service.delete('messenger', 'psid-123');

      expect(mockMappingRepo.remove).toHaveBeenCalled();
      expect(mockLearnerRepo.delete).toHaveBeenCalledWith({
        platform: 'messenger',
        externalUserId: 'psid-123',
      });
      expect(mockReminderRepo.delete).toHaveBeenCalledWith({
        platform: 'messenger',
        externalUserId: 'psid-123',
      });
      expect(mockClaimRepo.delete).toHaveBeenCalledWith({
        platform: 'messenger',
        externalUserId: 'psid-123',
      });
      expect(mockReportRepo.delete).toHaveBeenCalledWith({
        platform: 'messenger',
        externalUserId: 'psid-123',
      });
    });

    it('does not fail when mapping does not exist', async () => {
      mockMappingRepo.findOne.mockResolvedValue(null);
      mockLearnerRepo.delete.mockResolvedValue({ affected: 0 } as never);
      mockReminderRepo.delete.mockResolvedValue({ affected: 0 } as never);
      mockClaimRepo.delete.mockResolvedValue({ affected: 0 } as never);
      mockReportRepo.delete.mockResolvedValue({ affected: 0 } as never);

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
