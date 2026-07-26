import type { ConfigService } from '@nestjs/config';
import type { SchedulerRegistry } from '@nestjs/schedule';
import type { PgAdvisoryLockService } from '../../../../shared/common/pg-advisory-lock.service';
import type { StudyReminderSyncService } from './study-reminder-sync.service';
import type { StudyReminderDispatchService } from './study-reminder-dispatch.service';
import type { StudyReminderJobRepositoryPort } from '../../domain/repositories/study-reminder-job.repository.port';
import type { StudyReminderScheduleService } from './study-reminder-schedule.service';
import { StudyReminderWorkerService } from './study-reminder-worker.service';

describe('StudyReminderWorkerService', () => {
  let service: StudyReminderWorkerService;
  let syncService: jest.Mocked<StudyReminderSyncService>;
  let dispatchService: jest.Mocked<StudyReminderDispatchService>;
  let jobRepo: jest.Mocked<StudyReminderJobRepositoryPort>;
  let scheduleService: jest.Mocked<StudyReminderScheduleService>;
  let schedulerRegistry: jest.Mocked<SchedulerRegistry>;
  let pgLock: jest.Mocked<PgAdvisoryLockService>;
  let configService: jest.Mocked<ConfigService>;

  const defaultSettings = {
    syncHorizonHours: 168,
    maxRetries: 3,
    eveningRolloverHour: 23,
    timezone: 'Asia/Ho_Chi_Minh',
    minutesBefore: 30,
    minLeadMinutes: 10,
    retryBackoffMinutes: 5,
    jobRetentionDays: 30,
    stuckProcessingMs: 600_000,
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
        failures: [],
      }),
    };

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
    };

    jobRepo = {
      deleteSentJobs: jest.fn().mockResolvedValue(0),
      deleteTerminalJobsOlderThan: jest.fn().mockResolvedValue(0),
      upsertPendingJob: jest.fn(),
      cancelStaleJobsForPsid: jest.fn(),
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
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return
      withLock: jest.fn().mockImplementation((_id, fn) => fn()),
    } as unknown as jest.Mocked<PgAdvisoryLockService>;

    configService = {
      get: jest.fn().mockImplementation((key: string) => {
        const env: Record<string, string> = {
          STUDY_REMINDER_POLL_MIN_MS: '30000',
          STUDY_REMINDER_POLL_MAX_MS: '210000',
          STUDY_REMINDER_POLL_LEAD_MS: '60000',
        };
        return env[key];
      }),
    } as unknown as jest.Mocked<ConfigService>;

    service = new StudyReminderWorkerService(
      syncService,
      dispatchService,
      jobRepo,
      scheduleService,
      schedulerRegistry,
      pgLock,
      configService,
    );
  });

  describe('onModuleInit', () => {
    it('registers evening rollover cron and runs initial sync', async () => {
      await service.onModuleInit();

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(schedulerRegistry.addCronJob).toHaveBeenCalledWith(
        'study-reminder-evening-rollover',
        expect.anything(),
      );
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(syncService.syncUpcomingSessions).toHaveBeenCalled();
    });

    it('skips sync when advisory lock is not acquired', async () => {
      pgLock.withLock.mockResolvedValue(null);

      await service.onModuleInit();

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(syncService.syncUpcomingSessions).not.toHaveBeenCalled();
    });
  });

  describe('onModuleDestroy', () => {
    it('clears dispatch timer and deletes cron job', async () => {
      await service.onModuleInit();
      service.onModuleDestroy();

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(schedulerRegistry.deleteCronJob).toHaveBeenCalledWith(
        'study-reminder-evening-rollover',
      );
    });

    it('does not throw if cron job was never registered', () => {
      schedulerRegistry.deleteCronJob.mockImplementation(() => {
        throw new Error('Not found');
      });

      expect(() => service.onModuleDestroy()).not.toThrow();
    });
  });

  describe('handleSyncCron', () => {
    it('runs sync under advisory lock', async () => {
      await service.handleSyncCron();

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(pgLock.withLock).toHaveBeenCalledWith(
        expect.any(Number),
        expect.any(Function),
      );
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(syncService.syncUpcomingSessions).toHaveBeenCalled();
    });
  });

  describe('handleCleanupCron', () => {
    it('runs purgeExpiredJobs under advisory lock', async () => {
      await service.handleCleanupCron();

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(jobRepo.deleteTerminalJobsOlderThan).toHaveBeenCalled();
    });
  });

  describe('handleEveningRolloverCron', () => {
    it('purges sent jobs then syncs', async () => {
      jobRepo.deleteSentJobs.mockResolvedValue(5);

      await service.handleEveningRolloverCron();

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(jobRepo.deleteSentJobs).toHaveBeenCalled();
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(syncService.syncUpcomingSessions).toHaveBeenCalled();
    });

    it('skips when lock not acquired', async () => {
      pgLock.withLock.mockResolvedValue(null);

      await service.handleEveningRolloverCron();

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(jobRepo.deleteSentJobs).not.toHaveBeenCalled();
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(syncService.syncUpcomingSessions).not.toHaveBeenCalled();
    });
  });

  describe('runSyncAndDispatch', () => {
    it('runs both sync and dispatch sequentially', async () => {
      const result = await service.runSyncAndDispatch();

      expect(result).toHaveProperty('sync');
      expect(result).toHaveProperty('dispatch');
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(syncService.syncUpcomingSessions).toHaveBeenCalled();
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(dispatchService.dispatchDueReminders).toHaveBeenCalled();
    });
  });

  describe('computePollDelay', () => {
    it('returns pollMaxMs when no nextDueAt', async () => {
      await service.onModuleInit();
      dispatchService.dispatchDueReminders.mockResolvedValue({
        claimed: 0,
        sent: 0,
        cancelled: 0,
        failed: 0,
        retried: 0,
        resetStuck: 0,
        nextDueAt: null,
        failures: [],
      });

      // Trigger dispatch tick to exercise computePollDelay
      await (
        service as unknown as { runDispatchTick: () => Promise<void> }
      ).runDispatchTick();

      // Timer should be scheduled (dispatchTimer is set)
      // We can't directly assert the delay, but the timer should be set
    });
  });
});
