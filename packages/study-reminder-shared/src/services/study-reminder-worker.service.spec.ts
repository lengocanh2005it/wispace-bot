import type { SchedulerRegistry } from '@nestjs/schedule';
import {
  ADVISORY_LOCKS,
  type PgAdvisoryLockService,
} from '@wispace/bot-common/locks';
import { Logger } from '@nestjs/common';
import {
  StudyReminderWorkerService,
  studyReminderLockSkipsTotal,
} from './study-reminder-worker.service';
import type { StudyReminderSyncService } from './study-reminder-sync.service';
import type { StudyReminderDispatchService } from './study-reminder-dispatch.service';
import type { StudyReminderScheduleService } from './study-reminder-schedule.service';
import type { StudyReminderJobRepositoryPort } from '../ports/study-reminder-job.repository.port';

jest.mock('cron', () => {
  const CronJob = jest.fn().mockImplementation((cronTime: string) => ({
    cronTime: { source: cronTime },
    start: jest.fn(),
    stop: jest.fn(),
  }));
  return { CronJob };
});

describe('StudyReminderWorkerService', () => {
  let service: StudyReminderWorkerService;
  let syncService: jest.Mocked<StudyReminderSyncService>;
  let dispatchService: jest.Mocked<StudyReminderDispatchService>;
  let jobRepo: jest.Mocked<StudyReminderJobRepositoryPort>;
  let scheduleService: jest.Mocked<StudyReminderScheduleService>;
  let schedulerRegistry: jest.Mocked<SchedulerRegistry>;
  let pgLock: jest.Mocked<PgAdvisoryLockService>;
  let workerMetrics: {
    registerCron: jest.Mock;
    recordCronSuccess: jest.Mock;
    incStudyReminderLockSkip: jest.Mock;
  };

  const defaultSettings = {
    syncHorizonHours: 168,
    eveningRolloverHour: 23,
    timezone: 'Asia/Ho_Chi_Minh',
    minutesBefore: 30,
    minLeadMinutes: 10,
    retryBackoffMinutes: 5,
    jobRetentionDays: 30,
    stuckProcessingMs: 600_000,
    maxRetries: 3,
  };

  beforeEach(() => {
    syncService = {
      syncUpcomingSessions: jest.fn().mockResolvedValue({
        scope: 'all',
        linked: true,
        mappings: 0,
        upserted: 0,
        cancelled: 0,
        skipped: 0,
        failed: 0,
        cancelledOtherPlatforms: 0,
        failures: [],
      }),
    } as unknown as jest.Mocked<StudyReminderSyncService>;

    dispatchService = {
      dispatchDueReminders: jest.fn().mockResolvedValue({
        claimed: 0,
        sent: 0,
        cancelled: 0,
        failed: 0,
        retried: 0,
        resetStuck: 0,
        nextDueAt: null,
        failures: [],
      }),
    } as unknown as jest.Mocked<StudyReminderDispatchService>;

    jobRepo = {
      deleteSentJobs: jest.fn().mockResolvedValue(0),
      deleteTerminalJobsOlderThan: jest.fn().mockResolvedValue(0),
      upsertPendingJob: jest.fn(),
      cancelStaleJobsForExternalUserId: jest.fn(),
      cancelJobsFromOtherPlatforms: jest.fn(),
      findDueJobs: jest.fn(),
      claimJob: jest.fn(),
      markSent: jest.fn(),
      markCancelled: jest.fn(),
      markFailed: jest.fn(),
      resetStuckProcessingJobs: jest.fn(),
      findNextDueTime: jest.fn(),
      countJobsByStatus: jest.fn(),
      countTerminalFailedSince: jest.fn(),
      countStuckProcessing: jest.fn(),
      findTerminalFailedSince: jest.fn(),
      findStuckProcessing: jest.fn(),
    };

    scheduleService = {
      getOutboxSettings: jest.fn().mockReturnValue(defaultSettings),
      getDispatchSettings: jest.fn().mockReturnValue({
        pollMinMs: 30_000,
        pollMaxMs: 210_000,
        pollLeadMs: 60_000,
      }),
      computeRemindAt: jest.fn(),
      getMinutesUntilSession: jest.fn(),
      isSessionStarted: jest.fn(),
      formatScheduledTimeLabel: jest.fn(),
    } as unknown as jest.Mocked<StudyReminderScheduleService>;

    schedulerRegistry = {
      addCronJob: jest.fn(),
      deleteCronJob: jest.fn(),
    } as unknown as jest.Mocked<SchedulerRegistry>;

    pgLock = {
      withLock: jest
        .fn()
        .mockImplementation((_id: number, fn: () => Promise<unknown>) => fn()),
    } as unknown as jest.Mocked<PgAdvisoryLockService>;
    workerMetrics = {
      registerCron: jest.fn(),
      recordCronSuccess: jest.fn(),
      incStudyReminderLockSkip: jest.fn(),
    };
  });

  function build(
    lockIds?: { sync: number; cleanup: number; rollover: number },
    options?: {
      logLockSkips?: boolean;
      startupSyncSwallowErrors?: boolean;
      metrics?: typeof workerMetrics;
    },
  ): void {
    service = new StudyReminderWorkerService(
      syncService,
      dispatchService,
      scheduleService,
      schedulerRegistry,
      pgLock,
      jobRepo,
      'messenger',
      undefined,
      lockIds,
      options,
    );
  }

  describe('onModuleInit', () => {
    it('registers the evening rollover cron and runs initial sync', async () => {
      build();
      await service.onModuleInit();

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(schedulerRegistry.addCronJob).toHaveBeenCalledWith(
        'study-reminder-evening-rollover',
        expect.anything(),
      );
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(syncService.syncUpcomingSessions).toHaveBeenCalled();
    });

    it('registers heartbeat gauges and records successful cron runs', async () => {
      build(undefined, { metrics: workerMetrics });
      await service.onModuleInit();
      await service.handleSyncCron();
      await service.handleCleanupCron();
      await service.handleEveningRolloverCron();

      expect(workerMetrics.registerCron).toHaveBeenCalledWith(
        'study-reminder-sync',
        30 * 60 * 1000,
      );
      expect(workerMetrics.registerCron).toHaveBeenCalledWith(
        'study-reminder-cleanup',
        24 * 60 * 60 * 1000,
      );
      expect(workerMetrics.registerCron).toHaveBeenCalledWith(
        'study-reminder-evening-rollover',
        24 * 60 * 60 * 1000,
      );
      expect(workerMetrics.recordCronSuccess).toHaveBeenCalledWith(
        'study-reminder-sync',
      );
      expect(workerMetrics.recordCronSuccess).toHaveBeenCalledWith(
        'study-reminder-cleanup',
      );
      expect(workerMetrics.recordCronSuccess).toHaveBeenCalledWith(
        'study-reminder-evening-rollover',
      );
    });

    it('records a lock skip in the prefixed metrics adapter', async () => {
      pgLock.withLock.mockResolvedValue(null);
      build(undefined, { metrics: workerMetrics });
      await service.handleSyncCron();

      expect(workerMetrics.incStudyReminderLockSkip).toHaveBeenCalledWith(
        'messenger',
        'sync',
      );
      expect(workerMetrics.recordCronSuccess).not.toHaveBeenCalled();
    });

    it('registers the rollover cron at the configured hour', async () => {
      scheduleService.getOutboxSettings.mockReturnValue({
        ...defaultSettings,
        eveningRolloverHour: 22,
      });
      build();
      await service.onModuleInit();

      const added = schedulerRegistry.addCronJob.mock.calls[0]?.[1] as {
        cronTime: { source: string };
      };
      expect(added.cronTime.source).toBe('0 0 22 * * *');
    });

    it('skips sync when the advisory lock is not acquired', async () => {
      pgLock.withLock.mockResolvedValue(null);
      build({ sync: 1, cleanup: 2, rollover: 3 }, { logLockSkips: true });
      await service.onModuleInit();

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(syncService.syncUpcomingSessions).not.toHaveBeenCalled();
    });

    it('swallows startup sync errors when configured', async () => {
      syncService.syncUpcomingSessions.mockRejectedValue(new Error('DB down'));
      build(undefined, { startupSyncSwallowErrors: true });
      await expect(service.onModuleInit()).resolves.toBeUndefined();
    });

    it('propagates startup sync errors by default', async () => {
      syncService.syncUpcomingSessions.mockRejectedValue(new Error('DB down'));
      build();
      await expect(service.onModuleInit()).rejects.toThrow('DB down');
    });
  });

  describe('advisory lock ids', () => {
    it('uses the configured lock ids', async () => {
      build(
        { sync: 900_001, cleanup: 900_002, rollover: 900_003 },
        { logLockSkips: true },
      );
      await service.handleSyncCron();
      await service.handleCleanupCron();
      await service.handleEveningRolloverCron();

      const lockIds = pgLock.withLock.mock.calls.map((call) => call[0]);
      expect(lockIds).toContain(900_001);
      expect(lockIds).toContain(900_002);
      expect(lockIds).toContain(900_003);
    });
  });

  describe('runEveningRollover', () => {
    it('purges sent jobs and syncs', async () => {
      jobRepo.deleteSentJobs.mockResolvedValue(5);
      build();

      const result = await service.runEveningRollover();

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(jobRepo.deleteSentJobs).toHaveBeenCalledWith();
      expect(result).toMatchObject({ deletedSent: 5 });
      expect(result.sync).toHaveProperty('upserted');
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(syncService.syncUpcomingSessions).toHaveBeenCalled();
    });
  });

  describe('runSyncAndDispatch', () => {
    it('runs sync then dispatch and returns both results', async () => {
      build();
      const result = await service.runSyncAndDispatch();

      expect(result).toHaveProperty('sync');
      expect(result).toHaveProperty('dispatch');
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(syncService.syncUpcomingSessions).toHaveBeenCalled();
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(dispatchService.dispatchDueReminders).toHaveBeenCalled();
    });
  });

  describe('onModuleDestroy', () => {
    it('clears the dispatch timer and deletes the cron job', async () => {
      build();
      await service.onModuleInit();
      service.onModuleDestroy();

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(schedulerRegistry.deleteCronJob).toHaveBeenCalledWith(
        'study-reminder-evening-rollover',
      );
    });

    it('does not throw if the cron job was never registered', () => {
      schedulerRegistry.deleteCronJob.mockImplementation(() => {
        throw new Error('Not found');
      });
      build();

      expect(() => service.onModuleDestroy()).not.toThrow();
    });
  });

  describe('StudyReminderWorkerService — per-platform advisory lock ids (#777)', () => {
    /**
     * Faithful in-memory PgAdvisoryLockService: a Map keyed by lock id, held
     * for the duration of the callback — two concurrent holders of the same id
     * are mutually exclusive, different ids never contend. This models what
     * the fix changes (id selection), not Postgres itself.
     */
    class MemoryLockService {
      private readonly held = new Map<number, Promise<unknown> | null>();
      readonly skippedIds: number[] = [];

      withLock<T>(lockId: number, fn: () => Promise<T>): Promise<T | null> {
        if (this.held.get(lockId)) {
          this.skippedIds.push(lockId);
          return Promise.resolve(null);
        }
        const promise = fn().finally(() => this.held.set(lockId, null));
        this.held.set(lockId, promise);
        return promise;
      }
    }

    function buildWorker(
      lockSvc: MemoryLockService,
      platform: 'discord' | 'zalo' | 'messenger',
      lockIds?: { sync: number; cleanup: number; rollover: number },
      options?: { logLockSkips?: boolean },
    ): {
      service: StudyReminderWorkerService;
      syncService: { syncUpcomingSessions: jest.Mock };
    } {
      const syncService = {
        syncUpcomingSessions: jest.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              // Hold the lock long enough for the concurrent worker to attempt.
              setTimeout(() => {
                resolve({
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
              }, 20);
            }),
        ),
      };
      const dispatchService = {
        dispatchDueReminders: jest.fn().mockResolvedValue({
          claimed: 0,
          sent: 0,
          cancelled: 0,
          failed: 0,
          retried: 0,
          resetStuck: 0,
          nextDueAt: null,
          failures: [],
        }),
      };
      const jobRepo = {
        deleteSentJobs: jest.fn().mockResolvedValue(0),
        deleteTerminalJobsOlderThan: jest.fn().mockResolvedValue(0),
      };
      const scheduleService = {
        getOutboxSettings: jest.fn().mockReturnValue({
          syncHorizonHours: 168,
          eveningRolloverHour: 23,
          timezone: 'Asia/Ho_Chi_Minh',
          minutesBefore: 30,
          minLeadMinutes: 10,
          retryBackoffMinutes: 5,
          jobRetentionDays: 30,
          stuckProcessingMs: 600_000,
          maxRetries: 3,
        }),
        getDispatchSettings: jest.fn().mockReturnValue({
          pollMinMs: 30_000,
          pollMaxMs: 210_000,
          pollLeadMs: 60_000,
        }),
      };
      const schedulerRegistry = {
        addCronJob: jest.fn(),
        deleteCronJob: jest.fn(),
      };
      const service = new StudyReminderWorkerService(
        syncService as never,
        dispatchService as never,
        scheduleService as never,
        schedulerRegistry as never,
        lockSvc as never,
        jobRepo as never,
        platform,
        undefined,
        lockIds,
        options,
      );
      return { service, syncService };
    }

    beforeEach(() => {
      studyReminderLockSkipsTotal.reset();
    });

    it('runs two bots concurrently when each holds its own lock id', async () => {
      const lockSvc = new MemoryLockService();
      const discord = buildWorker(lockSvc, 'discord', {
        sync: ADVISORY_LOCKS.DISCORD_STUDY_REMINDER_SYNC,
        cleanup: ADVISORY_LOCKS.DISCORD_STUDY_REMINDER_CLEANUP,
        rollover: ADVISORY_LOCKS.DISCORD_STUDY_REMINDER_ROLLOVER,
      });
      const zalo = buildWorker(lockSvc, 'zalo', {
        sync: ADVISORY_LOCKS.ZALO_STUDY_REMINDER_SYNC,
        cleanup: ADVISORY_LOCKS.ZALO_STUDY_REMINDER_CLEANUP,
        rollover: ADVISORY_LOCKS.ZALO_STUDY_REMINDER_ROLLOVER,
      });

      await Promise.all([discord.service.runSync(), zalo.service.runSync()]);

      expect(discord.syncService.syncUpcomingSessions).toHaveBeenCalledTimes(1);
      expect(zalo.syncService.syncUpcomingSessions).toHaveBeenCalledTimes(1);
      expect(lockSvc.skippedIds).toEqual([]);
    });

    it('still skips when two bots contend on the same (pre-fix) lock id', async () => {
      const lockSvc = new MemoryLockService();
      const shared = 884_200_901;
      const a = buildWorker(lockSvc, 'discord', {
        sync: shared,
        cleanup: shared,
        rollover: shared,
      });
      const b = buildWorker(lockSvc, 'zalo', {
        sync: shared,
        cleanup: shared,
        rollover: shared,
      });

      await Promise.all([a.service.runSync(), b.service.runSync()]);

      expect(a.syncService.syncUpcomingSessions).toHaveBeenCalledTimes(1);
      expect(b.syncService.syncUpcomingSessions).not.toHaveBeenCalled();
      expect(lockSvc.skippedIds).toEqual([shared]);
    });

    it('defaults distinct sync/cleanup/rollover ids from the registry for every platform', () => {
      const lockSvc = new MemoryLockService();
      const messenger = buildWorker(lockSvc, 'messenger');
      const discord = buildWorker(lockSvc, 'discord');
      const zalo = buildWorker(lockSvc, 'zalo');

      // Messenger keeps its historical explicit ids via the worker defaults.
      expect(messenger.service['lockIds']).toEqual({
        sync: 884_200_901,
        cleanup: 884_200_902,
        rollover: 884_200_903,
      });
      expect(discord.service['lockIds']).toEqual({
        sync: ADVISORY_LOCKS.DISCORD_STUDY_REMINDER_SYNC,
        cleanup: ADVISORY_LOCKS.DISCORD_STUDY_REMINDER_CLEANUP,
        rollover: ADVISORY_LOCKS.DISCORD_STUDY_REMINDER_ROLLOVER,
      });
      expect(zalo.service['lockIds']).toEqual({
        sync: ADVISORY_LOCKS.ZALO_STUDY_REMINDER_SYNC,
        cleanup: ADVISORY_LOCKS.ZALO_STUDY_REMINDER_CLEANUP,
        rollover: ADVISORY_LOCKS.ZALO_STUDY_REMINDER_ROLLOVER,
      });
      const allNine = [
        messenger.service['lockIds'],
        discord.service['lockIds'],
        zalo.service['lockIds'],
      ].flatMap((ids) => [ids.sync, ids.cleanup, ids.rollover]);
      expect(new Set(allNine).size).toBe(9);
    });

    it('counts and warns on a periodic sync lock skip regardless of logLockSkips', async () => {
      const warnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const lockSvc = new MemoryLockService();
      // The periodic sync path never logs when logLockSkips is unset (D/Z default).
      const discord = buildWorker(lockSvc, 'discord');
      // Poison the sync lock so the next periodic tick loses the race.
      lockSvc.withLock(
        ADVISORY_LOCKS.DISCORD_STUDY_REMINDER_SYNC,
        () => new Promise(() => undefined),
      );

      await discord.service.handleSyncCron();

      expect(lockSvc.skippedIds).toEqual([
        ADVISORY_LOCKS.DISCORD_STUDY_REMINDER_SYNC,
      ]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('study-reminder sync skipped'),
      );
      warnSpy.mockRestore();
    });

    it('increments the lock-skip counter per platform and scope', async () => {
      const lockSvc = new MemoryLockService();
      const zalo = buildWorker(lockSvc, 'zalo');
      lockSvc.withLock(
        ADVISORY_LOCKS.ZALO_STUDY_REMINDER_SYNC,
        () => new Promise(() => undefined),
      );
      lockSvc.withLock(
        ADVISORY_LOCKS.ZALO_STUDY_REMINDER_CLEANUP,
        () => new Promise(() => undefined),
      );

      await zalo.service.handleSyncCron();
      await zalo.service.handleCleanupCron();

      const counts = (await studyReminderLockSkipsTotal.get()).values;
      const sync = counts.find(
        (v) => v.labels.platform === 'zalo' && v.labels.scope === 'sync',
      );
      const cleanup = counts.find(
        (v) => v.labels.platform === 'zalo' && v.labels.scope === 'cleanup',
      );
      expect(sync?.value).toBe(1);
      expect(cleanup?.value).toBe(1);
    });
  });
});
