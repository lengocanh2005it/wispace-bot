import {
  StudyReminderSyncService,
  type OnUserSyncHook,
} from './study-reminder-sync.service';
import type { MappingReaderPort } from '../ports/mapping-reader.port';
import type { StudyReminderJobRepositoryPort } from '../ports/study-reminder-job.repository.port';
import { StudyReminderScheduleService } from './study-reminder-schedule.service';
import type { StudySessionRecord } from '../types/study-reminder.types';

describe('StudyReminderSyncService', () => {
  let service: StudyReminderSyncService;
  let mappingReader: jest.Mocked<MappingReaderPort>;
  let jobRepo: jest.Mocked<StudyReminderJobRepositoryPort>;
  let scheduleService: jest.Mocked<StudyReminderScheduleService>;
  let onUserSync: jest.MockedFunction<OnUserSyncHook>;

  const defaultSettings = {
    timezone: 'Asia/Ho_Chi_Minh',
    minutesBefore: 30,
    minLeadMinutes: 5,
    syncHorizonHours: 168,
    eveningRolloverHour: 23,
    stuckProcessingMs: 600_000,
    jobRetentionDays: 7,
    maxRetries: 3,
    retryBackoffMinutes: 2,
  };

  function makeSession(
    overrides: Partial<StudySessionRecord> = {},
  ): StudySessionRecord {
    return {
      calendarId: 'calendar:42',
      sessionKey: 'calendar:42',
      // Future date relative to test run — CI-safe.
      scheduledAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
      topic: 'Toán',
      ...overrides,
    };
  }

  beforeEach(() => {
    mappingReader = {
      findActiveMappings: jest.fn().mockResolvedValue([]),
      findActiveMappingByExternalUserId: jest.fn().mockResolvedValue(null),
    };

    jobRepo = {
      upsertPendingJobs: jest.fn().mockResolvedValue([]),
      upsertPendingJob: jest.fn(),
      cancelStaleJobsForExternalUserId: jest.fn().mockResolvedValue(0),
      cancelJobsFromOtherPlatforms: jest.fn().mockResolvedValue(0),
      findDueJobs: jest.fn(),
      claimJob: jest.fn(),
      markSent: jest.fn(),
      markCancelled: jest.fn(),
      markFailed: jest.fn(),
      resetStuckProcessingJobs: jest.fn(),
      findNextDueTime: jest.fn(),
      deleteSentJobs: jest.fn(),
      deleteTerminalJobsOlderThan: jest.fn(),
      countJobsByStatus: jest.fn(),
      countTerminalFailedSince: jest.fn(),
      countStuckProcessing: jest.fn(),
      findTerminalFailedSince: jest.fn(),
      findStuckProcessing: jest.fn(),
    };

    scheduleService = {
      getOutboxSettings: jest.fn().mockReturnValue(defaultSettings),
      getDispatchSettings: jest.fn(),
      computeRemindAt: jest
        .fn()
        .mockImplementation((d: Date) => new Date(d.getTime() - 30 * 60_000)),
      getMinutesUntilSession: jest.fn(),
      isSessionStarted: jest.fn(),
      formatScheduledTimeLabel: jest.fn(),
    } as unknown as jest.Mocked<StudyReminderScheduleService>;

    onUserSync = jest.fn().mockResolvedValue(undefined);

    service = new StudyReminderSyncService(
      mappingReader,
      jobRepo,
      scheduleService,
      onUserSync,
    );
  });

  describe('syncUpcomingSessions (all)', () => {
    it('returns the full result shape with scope=all and no failures', async () => {
      const result = await service.syncUpcomingSessions();

      expect(result).toMatchObject({
        scope: 'all',
        linked: true,
        mappings: 0,
        upserted: 0,
        cancelled: 0,
        skipped: 0,
        failed: 0,
        cancelledOtherPlatforms: 0,
        failures: [],
      });
    });

    it('upserts jobs and cancels stale jobs', async () => {
      const session = makeSession();
      mappingReader.findActiveMappings.mockResolvedValue([
        { externalUserId: 'ext-1', userId: 1, platform: 'messenger' },
      ]);
      jobRepo.cancelStaleJobsForExternalUserId.mockResolvedValue(2);

      const result = await service.syncUpcomingSessions({
        getSessions: jest.fn().mockResolvedValue([session]),
      });

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(jobRepo.upsertPendingJobs).toHaveBeenCalledWith(
        [
          {
            platform: 'messenger',
            externalUserId: 'ext-1',
            userId: 1,
            sessionKey: 'calendar:42',
            scheduledAt: session.scheduledAt,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            remindAt: expect.any(Date),
            topic: 'Toán',
            maxRetries: 3,
          },
        ],
        {
          reopenOnlyOnScheduleChange: true,
        },
      );
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(jobRepo.upsertPendingJob).not.toHaveBeenCalled();
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(jobRepo.cancelStaleJobsForExternalUserId).toHaveBeenCalledWith(
        'messenger',
        'ext-1',
        ['calendar:42'],
        expect.any(Date),
        undefined,
      );
      expect(result).toMatchObject({ mappings: 1, upserted: 1, cancelled: 2 });
    });

    it('skips mappings without an external id', async () => {
      mappingReader.findActiveMappings.mockResolvedValue([
        { externalUserId: '', userId: 5, platform: 'messenger' },
      ]);

      const result = await service.syncUpcomingSessions();

      expect(result.skipped).toBe(1);
      expect(result.upserted).toBe(0);
    });

    it('collects per-mapping failures', async () => {
      mappingReader.findActiveMappings.mockResolvedValue([
        { externalUserId: 'ext-err', userId: 99, platform: 'messenger' },
      ]);
      jobRepo.upsertPendingJobs.mockRejectedValue(new Error('Wispace timeout'));

      const result = await service.syncUpcomingSessions({
        getSessions: jest.fn().mockResolvedValue([makeSession()]),
      });

      expect(result.failed).toBe(1);
      expect(result.failures).toEqual([
        { externalUserId: 'ext-err', error: 'Wispace timeout' },
      ]);
    });
  });

  describe('syncUpcomingSessions (user)', () => {
    it('returns linked=false when the userId lookup finds no mapping', async () => {
      const result = await service.syncUpcomingSessions({
        userId: 42,
        userIdMappingLookup: jest.fn().mockResolvedValue(null),
      });

      expect(result).toMatchObject({
        scope: 'user',
        userId: 42,
        linked: false,
        mappings: 0,
        skipped: 1,
      });
    });

    it('syncs a single user via the userId lookup hook', async () => {
      const session = makeSession();
      const lookup = jest.fn().mockResolvedValue({
        externalUserId: 'ext-1',
        userId: 42,
        platform: 'messenger',
      });

      const result = await service.syncUpcomingSessions({
        userId: 42,
        userIdMappingLookup: lookup,
        getSessions: jest.fn().mockResolvedValue([session]),
      });

      expect(lookup).toHaveBeenCalledWith(42);
      expect(result).toMatchObject({
        scope: 'user',
        userId: 42,
        linked: true,
        mappings: 1,
        upserted: 1,
      });
    });

    it('calls the onUserSync hook and surfaces cancelledOtherPlatforms', async () => {
      const session = makeSession();
      onUserSync.mockResolvedValue(3);

      const result = await service.syncUpcomingSessions({
        userId: 42,
        userIdMappingLookup: jest.fn().mockResolvedValue({
          externalUserId: 'ext-1',
          userId: 42,
          platform: 'messenger',
        }),
        getSessions: jest.fn().mockResolvedValue([session]),
      });

      expect(onUserSync).toHaveBeenCalledWith(42, 'messenger');
      expect(result.cancelledOtherPlatforms).toBe(3);
    });

    it('passes staleCancelStatuses to the stale-cancel call', async () => {
      mappingReader.findActiveMappingByExternalUserId.mockResolvedValue({
        externalUserId: 'ext-1',
        userId: 42,
        platform: 'messenger',
      });
      jobRepo.cancelStaleJobsForExternalUserId.mockResolvedValue(0);

      await service.syncUpcomingSessions({
        userId: 42,
        staleCancelStatuses: ['pending', 'failed', 'processing'],
      });

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(jobRepo.cancelStaleJobsForExternalUserId).toHaveBeenCalledWith(
        'messenger',
        'ext-1',
        [],
        expect.any(Date),
        { statuses: ['pending', 'failed', 'processing'] },
      );
    });
  });
});
