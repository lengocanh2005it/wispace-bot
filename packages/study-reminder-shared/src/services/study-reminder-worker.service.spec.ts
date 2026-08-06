import type { SchedulerRegistry } from '@nestjs/schedule';
import type { PgAdvisoryLockService } from '@wispace/bot-common';
import { StudyReminderWorkerService } from './study-reminder-worker.service';
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
  });

  function build(
    lockIds?: { sync: number; cleanup: number; rollover: number },
    options?: { logLockSkips?: boolean; startupSyncSwallowErrors?: boolean },
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
});
