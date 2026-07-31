import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { ADVISORY_LOCK } from '@messenger/shared/common/advisory-lock-ids';
import { PgAdvisoryLockService } from '@messenger/shared/common/pg-advisory-lock.service';
import {
  STUDY_REMINDER_JOB_REPOSITORY,
  type StudyReminderJobRepositoryPort,
  StudyReminderDispatchService,
  StudyReminderScheduleService,
} from '@wispace/study-reminder-shared';
import { StudyReminderSyncService } from './study-reminder-sync.service';

@Injectable()
export class StudyReminderWorkerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(StudyReminderWorkerService.name);
  private readonly eveningRolloverCronName = 'study-reminder-evening-rollover';
  private dispatchTimer: ReturnType<typeof setTimeout> | null = null;
  private shuttingDown = false;

  constructor(
    private readonly studyReminderSyncService: StudyReminderSyncService,
    private readonly studyReminderDispatchService: StudyReminderDispatchService,
    @Inject(STUDY_REMINDER_JOB_REPOSITORY)
    private readonly studyReminderJobRepository: StudyReminderJobRepositoryPort,
    private readonly studyReminderScheduleService: StudyReminderScheduleService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly pgLock: PgAdvisoryLockService,
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.registerEveningRolloverCron();

    // Skip startup sync if another pod is already syncing (rolling deploy).
    const result = await this.pgLock.withLock(
      ADVISORY_LOCK.STUDY_REMINDER_SYNC,
      async () => {
        try {
          await this.studyReminderSyncService.syncUpcomingSessions();
        } catch (error) {
          this.logger.error('Initial study reminder sync failed', error);
        }
      },
    );

    if (result === null) {
      this.logger.log(
        'Startup study reminder sync skipped — another pod holds the sync lock',
      );
    }

    // Start adaptive dispatch loop immediately after init.
    this.scheduleNextDispatch(0);
  }

  onModuleDestroy(): void {
    this.shuttingDown = true;
    if (this.dispatchTimer !== null) {
      clearTimeout(this.dispatchTimer);
      this.dispatchTimer = null;
    }

    try {
      this.schedulerRegistry.deleteCronJob(this.eveningRolloverCronName);
    } catch {
      // Cron may not have been registered if module init failed early.
    }
  }

  private registerEveningRolloverCron(): void {
    const { eveningRolloverHour, timezone } =
      this.studyReminderScheduleService.getOutboxSettings();
    const cronExpression = `0 0 ${eveningRolloverHour} * * *`;
    const job = new CronJob(
      cronExpression,
      () => {
        void this.handleEveningRolloverCron();
      },
      null,
      false,
      timezone,
    );

    this.schedulerRegistry.addCronJob(this.eveningRolloverCronName, job);
    job.start();

    this.logger.log(
      `Registered evening rollover cron at ${eveningRolloverHour}:00 (${timezone})`,
    );
  }

  @Cron('0 */30 * * * *', {
    name: 'study-reminder-sync',
  })
  async handleSyncCron(): Promise<void> {
    const result = await this.pgLock.withLock(
      ADVISORY_LOCK.STUDY_REMINDER_SYNC,
      () => this.studyReminderSyncService.syncUpcomingSessions(),
    );

    if (result === null) {
      this.logger.debug(
        'study-reminder-sync skipped — lock held by another pod',
      );
    }
  }

  private scheduleNextDispatch(delayMs: number): void {
    if (this.shuttingDown) {
      return;
    }

    this.dispatchTimer = setTimeout(() => {
      void this.runDispatchTick();
    }, delayMs);
    this.dispatchTimer.unref?.();
  }

  private async runDispatchTick(): Promise<void> {
    let nextDueAt: Date | null = null;
    try {
      // Dispatch uses claimJob (atomic UPDATE) — no advisory lock needed.
      // All pods can dispatch in parallel; only one claims each job.
      const result =
        await this.studyReminderDispatchService.dispatchDueReminders();
      nextDueAt = result.nextDueAt;
    } catch (error) {
      this.logger.error('Study reminder dispatch tick failed', error);
    }

    const delay = this.computePollDelay(nextDueAt);
    this.logger.debug(
      `Next dispatch poll in ${Math.round(delay / 1000)}s${nextDueAt ? ` (next job due ${nextDueAt.toISOString()})` : ''}`,
    );
    this.scheduleNextDispatch(delay);
  }

  private computePollDelay(nextDueAt: Date | null): number {
    const { pollMinMs, pollMaxMs, pollLeadMs } = this.pollConfig();
    if (!nextDueAt) return pollMaxMs;
    const msTilDue = nextDueAt.getTime() - Date.now();
    return Math.max(pollMinMs, Math.min(pollMaxMs, msTilDue - pollLeadMs));
  }

  private pollConfig(): {
    pollMinMs: number;
    pollMaxMs: number;
    pollLeadMs: number;
  } {
    const read = (key: string, def: number): number => {
      const v = Number(this.configService.get<string>(key));
      return Number.isFinite(v) && v > 0 ? Math.floor(v) : def;
    };
    return {
      pollMinMs: read('STUDY_REMINDER_POLL_MIN_MS', 30_000),
      pollMaxMs: read('STUDY_REMINDER_POLL_MAX_MS', 210_000),
      pollLeadMs: read('STUDY_REMINDER_POLL_LEAD_MS', 60_000),
    };
  }

  @Cron('0 0 3 * * *', {
    name: 'study-reminder-cleanup',
  })
  async handleCleanupCron(): Promise<void> {
    const result = await this.pgLock.withLock(
      ADVISORY_LOCK.STUDY_REMINDER_CLEANUP,
      async () => {
        try {
          await this.runCleanup();
        } catch (error) {
          this.logger.error('Study reminder job cleanup failed', error);
        }
      },
    );

    if (result === null) {
      this.logger.debug(
        'study-reminder-cleanup skipped — lock held by another pod',
      );
    }
  }

  async handleEveningRolloverCron(): Promise<void> {
    const result = await this.pgLock.withLock(
      ADVISORY_LOCK.STUDY_REMINDER_ROLLOVER,
      async () => {
        try {
          return await this.runEveningRollover();
        } catch (error) {
          this.logger.error('Study reminder evening rollover failed', error);
          return null;
        }
      },
    );

    if (result === null) {
      this.logger.debug(
        'study-reminder-evening-rollover skipped — lock held by another pod',
      );
    }
  }

  runSync() {
    return this.studyReminderSyncService.syncUpcomingSessions();
  }

  runDispatch() {
    return this.studyReminderDispatchService.dispatchDueReminders();
  }

  runCleanup() {
    return this.purgeExpiredJobs();
  }

  async runEveningRollover(): Promise<{
    deletedSent: number;
    sync: Awaited<ReturnType<StudyReminderSyncService['syncUpcomingSessions']>>;
  }> {
    const { syncHorizonHours } =
      this.studyReminderScheduleService.getOutboxSettings();

    this.logger.log(
      `Evening rollover: purge sent jobs, then sync next ${syncHorizonHours}h horizon`,
    );

    const { deleted: deletedSent } = await this.purgeSentJobs();
    const sync = await this.studyReminderSyncService.syncUpcomingSessions();

    this.logger.log(
      `Evening rollover done: deletedSent=${deletedSent}, upserted=${sync.upserted}, cancelled=${sync.cancelled}`,
    );

    return { deletedSent, sync };
  }

  async purgeSentJobs(): Promise<{ deleted: number }> {
    const deleted = await this.studyReminderJobRepository.deleteSentJobs();

    if (deleted > 0) {
      this.logger.log(`Purged ${deleted} sent study reminder job(s)`);
    }

    return { deleted };
  }

  async purgeExpiredJobs(): Promise<{ deleted: number; cutoff: string }> {
    const { jobRetentionDays } =
      this.studyReminderScheduleService.getOutboxSettings();
    const cutoff = new Date(
      Date.now() - jobRetentionDays * 24 * 60 * 60 * 1000,
    );

    const deleted =
      await this.studyReminderJobRepository.deleteTerminalJobsOlderThan(cutoff);

    if (deleted > 0) {
      this.logger.log(
        `Purged ${deleted} terminal study reminder job(s) (cancelled/failed) older than ${jobRetentionDays} day(s) (before ${cutoff.toISOString()})`,
      );
    }

    return { deleted, cutoff: cutoff.toISOString() };
  }

  async runSyncAndDispatch(): Promise<{
    sync: Awaited<ReturnType<StudyReminderSyncService['syncUpcomingSessions']>>;
    dispatch: Awaited<
      ReturnType<StudyReminderDispatchService['dispatchDueReminders']>
    >;
  }> {
    this.logger.log('Manual study reminder sync + dispatch');
    const sync = await this.runSync();
    const dispatch = await this.runDispatch();
    return { sync, dispatch };
  }
}
