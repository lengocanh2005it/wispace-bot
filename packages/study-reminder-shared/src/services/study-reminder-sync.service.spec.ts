import {
  StudyReminderSyncService,
  type OnUserSyncHook,
} from './study-reminder-sync.service';
import type { MappingReaderPort } from '../ports/mapping-reader.port';
import type { StudyReminderJobRepositoryPort } from '../ports/study-reminder-job.repository.port';
import { StudyReminderScheduleService } from './study-reminder-schedule.service';
import type { StudySessionRecord } from '../types/study-reminder.types';
import type { Platform } from '@wispace/contracts';

describe('StudyReminderSyncService', () => {
  let service: StudyReminderSyncService;
  let mappingReader: jest.Mocked<MappingReaderPort>;
  let jobRepo: jest.Mocked<StudyReminderJobRepositoryPort>;
  let scheduleService: jest.Mocked<StudyReminderScheduleService>;
  let onUserSync: jest.MockedFunction<OnUserSyncHook>;
  let canonicalResolver: jest.MockedFunction<
    (userId: number) => Promise<'messenger' | 'discord' | 'zalo' | undefined>
  >;

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
      findActiveMappingsPage: jest
        .fn()
        .mockResolvedValue({ items: [], nextId: undefined }),
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
    canonicalResolver = jest.fn().mockResolvedValue('messenger');

    service = new StudyReminderSyncService(
      mappingReader,
      jobRepo,
      scheduleService,
      onUserSync,
      canonicalResolver,
    );
  });

  describe('syncUpcomingSessions (all)', () => {
    it('throws when getSessions is missing (fail closed, jobs unchanged)', async () => {
      mappingReader.findActiveMappingsPage.mockResolvedValue({
        items: [{ externalUserId: 'ext-1', userId: 1, platform: 'messenger' }],
        nextId: undefined,
      });

      await expect(service.syncUpcomingSessions()).rejects.toThrow(
        'requires an authoritative getSessions provider',
      );
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(jobRepo.upsertPendingJobs).not.toHaveBeenCalled();
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(jobRepo.cancelStaleJobsForExternalUserId).not.toHaveBeenCalled();
    });

    it('returns the full result shape with scope=all and no failures', async () => {
      const result = await service.syncUpcomingSessions({
        getSessions: jest.fn().mockResolvedValue([]),
      });

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
      mappingReader.findActiveMappingsPage.mockResolvedValue({
        items: [{ externalUserId: 'ext-1', userId: 1, platform: 'messenger' }],
        nextId: undefined,
      });
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
      mappingReader.findActiveMappingsPage.mockResolvedValue({
        items: [{ externalUserId: '', userId: 5, platform: 'messenger' }],
        nextId: undefined,
      });

      const result = await service.syncUpcomingSessions({
        getSessions: jest.fn().mockResolvedValue([]),
      });

      expect(result.skipped).toBe(1);
      expect(result.upserted).toBe(0);
    });

    it('collects per-mapping failures', async () => {
      mappingReader.findActiveMappingsPage.mockResolvedValue({
        items: [
          { externalUserId: 'ext-err', userId: 99, platform: 'messenger' },
        ],
        nextId: undefined,
      });
      jobRepo.upsertPendingJobs.mockRejectedValue(new Error('Wispace timeout'));

      const result = await service.syncUpcomingSessions({
        getSessions: jest.fn().mockResolvedValue([makeSession()]),
      });

      expect(result.failed).toBe(1);
      expect(result.failures).toEqual([
        { externalUserId: 'ext-err', error: 'Wispace timeout' },
      ]);
    });

    it('pages mappings with the keyset cursor until a short page', async () => {
      const session = makeSession();
      const mappings = Array.from({ length: 150 }, (_, i) => ({
        externalUserId: `ext-${i}`,
        userId: i + 1,
        platform: 'messenger' as const,
      }));
      mappingReader.findActiveMappingsPage
        .mockResolvedValueOnce({
          items: mappings.slice(0, 100),
          nextId: '100',
        })
        .mockResolvedValueOnce({
          items: mappings.slice(100),
          nextId: undefined,
        });
      const getSessions = jest.fn().mockResolvedValue([session]);

      const result = await service.syncUpcomingSessions({ getSessions });

      expect(result.mappings).toBe(150);
      expect(result.upserted).toBe(150);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mappingReader.findActiveMappingsPage).toHaveBeenCalledWith(
        'messenger',
        { limit: 100, afterId: undefined },
      );
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mappingReader.findActiveMappingsPage).toHaveBeenCalledWith(
        'messenger',
        { limit: 100, afterId: '100' },
      );
      expect(getSessions).toHaveBeenCalledTimes(150);
    });
  });

  describe('syncUpcomingSessions (user)', () => {
    it('returns linked=false when the userId lookup finds no mapping', async () => {
      const result = await service.syncUpcomingSessions({
        userId: 42,
        userIdMappingLookup: jest.fn().mockResolvedValue(null),
        getSessions: jest.fn().mockResolvedValue([]),
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
        // Authoritative empty calendar — cancelling stale jobs is correct here.
        getSessions: jest.fn().mockResolvedValue([]),
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
    it('cancels pending jobs and skips upsert when current platform is not canonical for the user', async () => {
      const canonicalResolver = jest.fn().mockResolvedValue('zalo'); // canonical is zalo, but syncing messenger
      const syncService = new StudyReminderSyncService(
        mappingReader,
        jobRepo,
        scheduleService,
        onUserSync,
        canonicalResolver,
      );

      const mapping = {
        externalUserId: 'psid-1',
        userId: 42,
        platform: 'messenger' as const,
      };
      mappingReader.findActiveMappingsPage.mockResolvedValueOnce({
        items: [mapping],
        nextId: undefined,
      });
      jobRepo.cancelStaleJobsForExternalUserId.mockResolvedValueOnce(2);

      const result = await syncService.syncUpcomingSessions({
        platform: 'messenger',
        staleCancelStatuses: ['pending', 'failed', 'processing'],
        getSessions: jest.fn().mockResolvedValue([makeSession()]),
      });

      expect(canonicalResolver).toHaveBeenCalledWith(42);
      expect(jobRepo.cancelStaleJobsForExternalUserId).toHaveBeenCalledWith(
        'messenger',
        'psid-1',
        [],
        expect.any(Date),
        { statuses: ['pending', 'failed'] },
      );
      expect(jobRepo.upsertPendingJobs).not.toHaveBeenCalled();
      expect(result.skipped).toBe(1);
      expect(result.cancelled).toBe(2);
    });

    it.each(['messenger', 'discord', 'zalo'] as const)(
      'proceeds with upsert when current platform (%s) is canonical for the user',
      async (platform) => {
        const canonicalResolver = jest.fn().mockResolvedValue(platform);
        const syncService = new StudyReminderSyncService(
          mappingReader,
          jobRepo,
          scheduleService,
          onUserSync,
          canonicalResolver,
        );

        const mapping = {
          externalUserId: `${platform}-1`,
          userId: 42,
          platform,
        };
        mappingReader.findActiveMappingsPage.mockResolvedValueOnce({
          items: [mapping],
          nextId: undefined,
        });
        const getSessions = jest.fn().mockResolvedValue([makeSession()]);

        const result = await syncService.syncUpcomingSessions({
          platform,
          getSessions,
        });

        expect(canonicalResolver).toHaveBeenCalledWith(42);
        expect(getSessions).toHaveBeenCalledWith(`${platform}-1`, 42);
        expect(jobRepo.upsertPendingJobs).toHaveBeenCalled();
        expect(result.upserted).toBe(1);
      },
    );

    it('keeps one active reminder and converges after the canonical platform changes', async () => {
      const userId = 42;
      const session = makeSession({ sessionKey: 'shared-session' });
      const jobs = new Map<
        string,
        {
          platform: Platform;
          externalUserId: string;
          sessionKey: string;
          status: 'pending' | 'failed' | 'cancelled';
        }
      >();
      let canonicalPlatform: Platform = 'zalo';

      const buildService = (platform: Platform) => {
        const externalUserId = `${platform}-1`;
        const mappingReader = {
          findActiveMappingsPage: jest.fn().mockResolvedValue({
            items: [{ externalUserId, userId, platform }],
            nextId: undefined,
          }),
        } as unknown as MappingReaderPort;
        const jobRepository = {
          upsertPendingJobs: jest.fn(async (inputs) => {
            for (const input of inputs) {
              jobs.set(`${input.platform}:${input.sessionKey}`, {
                platform: input.platform,
                externalUserId: input.externalUserId,
                sessionKey: input.sessionKey,
                status: 'pending',
              });
            }
            return [];
          }),
          cancelStaleJobsForExternalUserId: jest.fn(
            async (platformToCancel, externalId, activeSessionKeys) => {
              let cancelled = 0;
              for (const job of jobs.values()) {
                if (
                  job.platform === platformToCancel &&
                  job.externalUserId === externalId &&
                  !activeSessionKeys.includes(job.sessionKey) &&
                  (job.status === 'pending' || job.status === 'failed')
                ) {
                  job.status = 'cancelled';
                  cancelled += 1;
                }
              }
              return cancelled;
            },
          ),
        } as unknown as StudyReminderJobRepositoryPort;
        const scheduleService = {
          getOutboxSettings: jest.fn().mockReturnValue(defaultSettings),
          computeRemindAt: jest.fn((date: Date) => date),
        } as unknown as StudyReminderScheduleService;

        return new StudyReminderSyncService(
          mappingReader,
          jobRepository,
          scheduleService,
          undefined,
          async () => canonicalPlatform,
        );
      };

      const services = new Map<Platform, StudyReminderSyncService>(
        (['messenger', 'discord', 'zalo'] as const).map((platform) => [
          platform,
          buildService(platform),
        ]),
      );
      const sync = (platform: Platform) =>
        services.get(platform)!.syncUpcomingSessions({
          platform,
          getSessions: jest.fn().mockResolvedValue([session]),
        });

      await Promise.all((['messenger', 'discord', 'zalo'] as const).map(sync));
      expect(
        [...jobs.values()].filter((job) => job.status !== 'cancelled'),
      ).toEqual([
        expect.objectContaining({
          platform: 'zalo',
          sessionKey: 'shared-session',
        }),
      ]);

      canonicalPlatform = 'discord';
      await sync('messenger');
      await sync('zalo');
      await sync('discord');

      expect(
        [...jobs.values()].filter((job) => job.status !== 'cancelled'),
      ).toEqual([
        expect.objectContaining({
          platform: 'discord',
          sessionKey: 'shared-session',
        }),
      ]);
      expect(jobs.get('zalo:shared-session')?.status).toBe('cancelled');
    });

    it('fails closed on an undefined canonical platform and cancels cancelable jobs', async () => {
      const resolver = jest.fn().mockResolvedValue(undefined);
      const syncService = new StudyReminderSyncService(
        mappingReader,
        jobRepo,
        scheduleService,
        onUserSync,
        resolver,
      );
      const mapping = {
        externalUserId: 'discord-1',
        userId: 42,
        platform: 'discord' as const,
      };
      mappingReader.findActiveMappingsPage.mockResolvedValueOnce({
        items: [mapping],
        nextId: undefined,
      });
      jobRepo.cancelStaleJobsForExternalUserId.mockResolvedValueOnce(2);
      const getSessions = jest.fn().mockResolvedValue([makeSession()]);

      const result = await syncService.syncUpcomingSessions({
        platform: 'discord',
        getSessions,
      });

      expect(resolver).toHaveBeenCalledWith(42);
      expect(getSessions).not.toHaveBeenCalled();
      expect(jobRepo.upsertPendingJobs).not.toHaveBeenCalled();
      expect(jobRepo.cancelStaleJobsForExternalUserId).toHaveBeenCalledWith(
        'discord',
        'discord-1',
        [],
        expect.any(Date),
        { statuses: ['pending', 'failed'] },
      );
      expect(result).toMatchObject({
        skipped: 1,
        upserted: 0,
        cancelled: 2,
        failed: 0,
      });
    });

    it('fails closed on a resolver error without changing existing jobs', async () => {
      const resolver = jest.fn().mockRejectedValue(new Error('DB unavailable'));
      const syncService = new StudyReminderSyncService(
        mappingReader,
        jobRepo,
        scheduleService,
        onUserSync,
        resolver,
      );
      mappingReader.findActiveMappingsPage.mockResolvedValueOnce({
        items: [
          { externalUserId: 'discord-1', userId: 42, platform: 'discord' },
        ],
        nextId: undefined,
      });

      const result = await syncService.syncUpcomingSessions({
        platform: 'discord',
        getSessions: jest.fn().mockResolvedValue([makeSession()]),
      });

      expect(jobRepo.upsertPendingJobs).not.toHaveBeenCalled();
      expect(jobRepo.cancelStaleJobsForExternalUserId).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        skipped: 0,
        upserted: 0,
        cancelled: 0,
        failed: 1,
      });
      expect(result.failures?.[0]?.error).toContain('DB unavailable');
    });

    it('fails closed when a mapping has no WISPACE userId', async () => {
      mappingReader.findActiveMappingsPage.mockResolvedValueOnce({
        items: [{ externalUserId: 'discord-1', platform: 'discord' }],
        nextId: undefined,
      });

      const result = await service.syncUpcomingSessions({
        platform: 'discord',
        getSessions: jest.fn().mockResolvedValue([makeSession()]),
      });

      expect(canonicalResolver).not.toHaveBeenCalled();
      expect(jobRepo.upsertPendingJobs).not.toHaveBeenCalled();
      expect(jobRepo.cancelStaleJobsForExternalUserId).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        skipped: 0,
        upserted: 0,
        cancelled: 0,
        failed: 1,
      });
      expect(result.failures?.[0]?.error).toContain('WISPACE userId');
    });
  });
});
