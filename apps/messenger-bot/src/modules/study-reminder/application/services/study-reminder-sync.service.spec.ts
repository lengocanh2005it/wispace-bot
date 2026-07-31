import type { MessengerMappingReaderPort } from '@messenger/shared/ports/messenger-mapping-reader.port';
import type { StudyReminderJobRepositoryPort } from '../../domain/repositories/study-reminder-job.repository.port';
import type { StudySessionSourceService } from './study-session-source.service';
import type { StudyReminderScheduleService } from '@wispace/study-reminder-shared';
import type { NormalizedStudySession } from '../../domain/entities/study-schedule.types';
import { StudyReminderSyncService } from './study-reminder-sync.service';

describe('StudyReminderSyncService', () => {
  let service: StudyReminderSyncService;
  let mappingReader: jest.Mocked<MessengerMappingReaderPort>;
  let sessionSource: jest.Mocked<StudySessionSourceService>;
  let jobRepo: jest.Mocked<StudyReminderJobRepositoryPort>;
  let scheduleService: jest.Mocked<StudyReminderScheduleService>;

  const defaultSettings = {
    syncHorizonHours: 168,
    maxRetries: 3,
  };

  function makeSession(
    overrides: Partial<NormalizedStudySession> = {},
  ): NormalizedStudySession {
    return {
      sessionKey: 'calendar:42',
      scheduledAt: new Date('2026-07-15T10:00:00Z'),
      topic: 'Toán',
      ...overrides,
    };
  }

  beforeEach(() => {
    mappingReader = {
      findActiveMappingByPsid: jest.fn().mockResolvedValue(null),
      findActiveMappingByUserId: jest.fn().mockResolvedValue(null),
      findActiveMappingsWithPsid: jest.fn().mockResolvedValue([]),
    };

    sessionSource = {
      getUpcomingSessions: jest.fn().mockResolvedValue([]),
    };

    jobRepo = {
      upsertPendingJob: jest.fn(),
      cancelStaleJobsForPsid: jest.fn().mockResolvedValue(0),
      cancelJobsFromOtherPlatforms: jest.fn().mockResolvedValue(0),
      findDueJobs: jest.fn(),
      claimJob: jest.fn(),
      markSent: jest.fn(),
      markCancelled: jest.fn(),
      markFailed: jest.fn(),
      resetStuckProcessingJobs: jest.fn(),
      findNextDueTime: jest.fn(),
    };

    scheduleService = {
      getOutboxSettings: jest.fn().mockReturnValue(defaultSettings),
      computeRemindAt: jest
        .fn()
        .mockImplementation((d: Date) => new Date(d.getTime() - 30 * 60_000)),
      getMinutesUntilSession: jest.fn(),
      isSessionStarted: jest.fn(),
      formatScheduledTimeLabel: jest.fn(),
    } as unknown as jest.Mocked<StudyReminderScheduleService>;

    service = new StudyReminderSyncService(
      mappingReader,
      sessionSource,
      jobRepo,
      scheduleService,
    );
  });

  describe('syncUpcomingSessions (all)', () => {
    it('returns empty result when no active mappings exist', async () => {
      const result = await service.syncUpcomingSessions();

      expect(result).toMatchObject({
        scope: 'all',
        linked: true,
        mappings: 0,
        upserted: 0,
        cancelled: 0,
        skipped: 0,
        failures: [],
      });
    });

    it('upserts jobs for sessions and cancels stale jobs', async () => {
      const session = makeSession();
      mappingReader.findActiveMappingsWithPsid.mockResolvedValue([
        { psid: 'psid-1', userId: 1 },
      ]);
      sessionSource.getUpcomingSessions.mockResolvedValue([session]);
      jobRepo.cancelStaleJobsForPsid.mockResolvedValue(2);

      const result = await service.syncUpcomingSessions();

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(jobRepo.upsertPendingJob).toHaveBeenCalledWith({
        platform: 'messenger',
        psid: 'psid-1',
        userId: 1,
        sessionKey: 'calendar:42',
        scheduledAt: session.scheduledAt,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        remindAt: expect.any(Date),
        topic: 'Toán',
        maxRetries: 3,
      });
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(jobRepo.cancelStaleJobsForPsid).toHaveBeenCalledWith(
        'psid-1',
        ['calendar:42'],
        expect.any(Date),
        'messenger',
      );
      expect(result).toMatchObject({
        mappings: 1,
        upserted: 1,
        cancelled: 2,
      });
    });

    it('records failure when session source throws', async () => {
      mappingReader.findActiveMappingsWithPsid.mockResolvedValue([
        { psid: 'psid-err', userId: 99 },
      ]);
      sessionSource.getUpcomingSessions.mockRejectedValue(
        new Error('Wispace timeout'),
      );

      const result = await service.syncUpcomingSessions();

      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toMatchObject({
        psid: 'psid-err',
        error: 'Wispace timeout',
      });
      expect(result.upserted).toBe(0);
    });

    it('skips mappings without psid', async () => {
      mappingReader.findActiveMappingsWithPsid.mockResolvedValue([
        { userId: 5 },
      ]);

      const result = await service.syncUpcomingSessions();

      expect(result.skipped).toBe(1);
      expect(result.upserted).toBe(0);
    });
  });

  describe('syncUpcomingSessions (user)', () => {
    it('returns linked=false when user has no active mapping', async () => {
      const result = await service.syncUpcomingSessions({ userId: 42 });

      expect(result).toMatchObject({
        scope: 'user',
        userId: 42,
        linked: false,
        mappings: 0,
        skipped: 1,
      });
    });

    it('syncs sessions for a single user', async () => {
      const session = makeSession();
      mappingReader.findActiveMappingByUserId.mockResolvedValue({
        psid: 'psid-1',
        userId: 42,
      });
      sessionSource.getUpcomingSessions.mockResolvedValue([session]);

      const result = await service.syncUpcomingSessions({ userId: 42 });

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(jobRepo.cancelJobsFromOtherPlatforms).toHaveBeenCalledWith(
        42,
        'messenger',
      );
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(sessionSource.getUpcomingSessions).toHaveBeenCalledWith({
        psid: 'psid-1',
        userId: 42,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        horizonEnd: expect.any(Date),
      });
      expect(result).toMatchObject({
        scope: 'user',
        userId: 42,
        linked: true,
        mappings: 1,
        upserted: 1,
        cancelledOtherPlatforms: 0,
      });
    });

    it('records failure when session source throws for a user', async () => {
      mappingReader.findActiveMappingByUserId.mockResolvedValue({
        psid: 'psid-1',
        userId: 42,
      });
      sessionSource.getUpcomingSessions.mockRejectedValue(
        new Error('Network error'),
      );

      const result = await service.syncUpcomingSessions({ userId: 42 });

      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.error).toBe('Network error');
    });

    it('cancels jobs from other platforms before syncing', async () => {
      const session = makeSession();
      mappingReader.findActiveMappingByUserId.mockResolvedValue({
        psid: 'psid-1',
        userId: 42,
      });
      sessionSource.getUpcomingSessions.mockResolvedValue([session]);
      jobRepo.cancelJobsFromOtherPlatforms.mockResolvedValue(3);

      const result = await service.syncUpcomingSessions({
        userId: 42,
        platform: 'discord',
      });

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(jobRepo.cancelJobsFromOtherPlatforms).toHaveBeenCalledWith(
        42,
        'discord',
      );
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(jobRepo.upsertPendingJob).toHaveBeenCalledWith(
        expect.objectContaining({ platform: 'discord' }),
      );
      expect(result).toMatchObject({
        cancelledOtherPlatforms: 3,
      });
    });
  });
});
