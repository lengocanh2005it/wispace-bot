import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { Cron, SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { Counter } from 'prom-client';
import {
  ADVISORY_LOCKS,
  PgAdvisoryLockService,
} from '@wispace/bot-common/locks';
import { errorMessage } from '@wispace/bot-common/masking';
import { StudyReminderSyncService } from './study-reminder-sync.service';
import { StudyReminderDispatchService } from './study-reminder-dispatch.service';
import { StudyReminderScheduleService } from './study-reminder-schedule.service';
import {
  STUDY_REMINDER_JOB_REPOSITORY,
  type StudyReminderJobRepositoryPort,
} from '../ports/study-reminder-job.repository.port';
import { subDays } from 'date-fns';
import type {
  GetSessionsFn,
  StudyReminderSyncResult,
} from '../types/study-reminder.types';
import type { Platform } from '@wispace/contracts';
import type { StudyReminderDispatchResult } from './study-reminder-dispatch.service';

const ADVISORY_LOCK_SYNC = 884_200_901;
const ADVISORY_LOCK_CLEANUP = 884_200_902;
const ADVISORY_LOCK_ROLLOVER = 884_200_903;

/**
 * Per-platform worker lock ids (#777) — each bot owns sync/cleanup/rollover
 * ids of its own, so the fleet's half-hourly syncs never contend. The
 * messenger ids are the historical 901/902/903; Discord and Zalo come from
 * the shared ADVISORY_LOCKS registry. `createStudyReminderProviders` still
 * requires explicit ids in production wiring (fail-closed).
 */
const DEFAULT_LOCK_IDS: Record<Platform, StudyReminderWorkerLockIds> = {
  messenger: {
    sync: ADVISORY_LOCK_SYNC,
    cleanup: ADVISORY_LOCK_CLEANUP,
    rollover: ADVISORY_LOCK_ROLLOVER,
  },
  discord: {
    sync: ADVISORY_LOCKS.DISCORD_STUDY_REMINDER_SYNC,
    cleanup: ADVISORY_LOCKS.DISCORD_STUDY_REMINDER_CLEANUP,
    rollover: ADVISORY_LOCKS.DISCORD_STUDY_REMINDER_ROLLOVER,
  },
  zalo: {
    sync: ADVISORY_LOCKS.ZALO_STUDY_REMINDER_SYNC,
    cleanup: ADVISORY_LOCKS.ZALO_STUDY_REMINDER_CLEANUP,
    rollover: ADVISORY_LOCKS.ZALO_STUDY_REMINDER_ROLLOVER,
  },
};

/** #777: a lock skip is distinguishable from "synced, nothing to do". */
export const studyReminderLockSkipsTotal = new Counter({
  name: 'study_reminder_lock_skips_total',
  help: 'Study-reminder worker cron/startup runs skipped because another holder owns the advisory lock',
  labelNames: ['platform', 'scope'] as const,
});

export interface StudyReminderWorkerLockIds {
  sync: number;
  cleanup: number;
  rollover: number;
}

export interface StudyReminderWorkerOptions {
  /**
   * Messenger: log when a cron/startup sync is skipped because another pod
   * holds the advisory lock (rolling deploys).
   */
  logLockSkips?: boolean;
  /**
   * Messenger: swallow startup sync errors (log only) so a transient DB/API
   * failure does not kill the process at boot.
   */
  startupSyncSwallowErrors?: boolean;
}

@Injectable()
export class StudyReminderWorkerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(StudyReminderWorkerService.name);
  private readonly eveningRolloverCronName = 'study-reminder-evening-rollover';
  private dispatchTimer: ReturnType<typeof setTimeout> | null = null;
  private shuttingDown = false;
  private readonly platform: Platform;
  private readonly getSessions?: GetSessionsFn;
  private readonly lockIds: StudyReminderWorkerLockIds;
  private readonly options: StudyReminderWorkerOptions;

  constructor(
    private readonly syncService: StudyReminderSyncService,
    private readonly dispatchService: StudyReminderDispatchService,
    private readonly scheduleService: StudyReminderScheduleService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly pgLock: PgAdvisoryLockService,
    @Optional()
    @Inject(STUDY_REMINDER_JOB_REPOSITORY)
    private readonly jobRepository?: StudyReminderJobRepositoryPort,
    platform: Platform = 'messenger',
    getSessions?: GetSessionsFn,
    lockIds?: Partial<StudyReminderWorkerLockIds>,
    options?: StudyReminderWorkerOptions,
  ) {
    this.platform = platform;
    this.getSessions = getSessions;
    this.lockIds = {
      sync: lockIds?.sync ?? DEFAULT_LOCK_IDS[platform].sync,
      cleanup: lockIds?.cleanup ?? DEFAULT_LOCK_IDS[platform].cleanup,
      rollover: lockIds?.rollover ?? DEFAULT_LOCK_IDS[platform].rollover,
    };
    this.options = options ?? {};
  }

  async onModuleInit(): Promise<void> {
    this.registerEveningRolloverCron();
    await this.runInitialSync();
    this.scheduleNextDispatch(0);
  }

  onModuleDestroy(): void {
    this.shuttingDown = true;
    if (this.dispatchTimer) {
      clearTimeout(this.dispatchTimer);
      this.dispatchTimer = null;
    }
    try {
      this.schedulerRegistry.deleteCronJob(this.eveningRolloverCronName);
    } catch {
      // ignore if not registered
    }
  }

  // ── Public convenience methods ──────────────────────────────────────────

  async runSync(): Promise<StudyReminderSyncResult | null> {
    return this.runInitialSync();
  }

  async runDispatch(): Promise<StudyReminderDispatchResult> {
    return this.dispatchService.dispatchDueReminders();
  }

  async runCleanup(): Promise<void> {
    await this.handleCleanupCron();
  }

  async runEveningRollover(): Promise<{
    deletedSent: number;
    sync: StudyReminderSyncResult;
  }> {
    const { syncHorizonHours } = this.scheduleService.getOutboxSettings();

    this.logger.log(
      `Evening rollover: purge sent jobs, then sync next ${syncHorizonHours}h horizon`,
    );

    const deletedSent = await this.deleteSentJobsInternal();
    const sync = await this.syncService.syncUpcomingSessions({
      platform: this.platform,
      getSessions: this.getSessions,
    });

    this.logger.log(
      `Evening rollover done: deletedSent=${deletedSent}, upserted=${sync.upserted}, cancelled=${sync.cancelled}`,
    );

    return { deletedSent, sync };
  }

  async runSyncAndDispatch(): Promise<{
    sync: StudyReminderSyncResult | null;
    dispatch: StudyReminderDispatchResult;
  }> {
    this.logger.log('Manual study reminder sync + dispatch');
    const sync = await this.runSync();
    const dispatch = await this.runDispatch();
    return { sync, dispatch };
  }

  // ── Initial sync ────────────────────────────────────────────────────────

  private async runInitialSync(): Promise<StudyReminderSyncResult | null> {
    if (this.options.startupSyncSwallowErrors) {
      try {
        return await this.runSyncLocked(this.options.logLockSkips === true);
      } catch (error) {
        this.logger.error('Initial study reminder sync failed', error);
        return null;
      }
    }
    return this.runSyncLocked(this.options.logLockSkips === true);
  }

  // ── Sync cron (every 30 min) ────────────────────────────────────────────

  @Cron('0 */30 * * * *', {
    name: 'study-reminder-sync',
    timeZone: 'Asia/Ho_Chi_Minh',
  })
  async handleSyncCron(): Promise<void> {
    // Periodic sync: a skip here means a DIFFERENT platform's bot holds this
    // bot's lock id (same-platform rolling deploys overlap the startup sync,
    // not this one). That is a configuration defect — always warn + count.
    // `logLockSkip: false` — no "Startup…" info line on the periodic path.
    const result = await this.runSyncLocked(false);
    if (result === null) {
      this.logger.warn(
        `Periodic study-reminder sync skipped — another holder owns the sync lock (platform=${this.platform})`,
      );
      studyReminderLockSkipsTotal
        .labels({ platform: this.platform, scope: 'sync' })
        .inc();
    }
  }

  private async runSyncLocked(
    logLockSkip: boolean,
  ): Promise<StudyReminderSyncResult | null> {
    const result = await this.pgLock.withLock(this.lockIds.sync, () =>
      this.syncService.syncUpcomingSessions({
        platform: this.platform,
        getSessions: this.getSessions,
      }),
    );

    if (result === null && logLockSkip) {
      this.logger.log(
        'Startup study reminder sync skipped — another pod holds the sync lock',
      );
    }

    return result;
  }

  // ── Cleanup cron (03:00 ICT) ────────────────────────────────────────────

  @Cron('0 0 3 * * *', {
    name: 'study-reminder-cleanup',
    timeZone: 'Asia/Ho_Chi_Minh',
  })
  async handleCleanupCron(): Promise<void> {
    const result = await this.pgLock.withLock(
      this.lockIds.cleanup,
      async () => {
        if (this.jobRepository) {
          const settings = this.scheduleService.getOutboxSettings();
          const cutoff = subDays(new Date(), settings.jobRetentionDays);
          const deleted =
            await this.jobRepository.deleteTerminalJobsOlderThan(cutoff);
          if (deleted > 0) {
            this.logger.log(
              `Cleanup: deleted ${deleted} terminal jobs older than ${settings.jobRetentionDays} days`,
            );
          }
        }
        return true;
      },
    );

    if (result === null) {
      studyReminderLockSkipsTotal
        .labels({ platform: this.platform, scope: 'cleanup' })
        .inc();
      if (this.options.logLockSkips) {
        this.logger.debug(
          'study-reminder-cleanup skipped — lock held by another pod',
        );
      }
    }
  }

  // ── Evening rollover cron (registered dynamically per timezone/hour) ────

  private registerEveningRolloverCron(): void {
    const { eveningRolloverHour, timezone } =
      this.scheduleService.getOutboxSettings();
    const job = new CronJob(
      `0 0 ${eveningRolloverHour} * * *`,
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

  async handleEveningRolloverCron(): Promise<void> {
    const result = await this.pgLock.withLock(
      this.lockIds.rollover,
      async () => {
        if (!this.jobRepository) {
          return {
            mappings: 0,
            upserted: 0,
            cancelled: 0,
            skipped: 0,
            failed: 0,
          };
        }
        const deletedSent = await this.deleteSentJobsInternal();
        if (deletedSent > 0) {
          this.logger.log(`Evening rollover: purged ${deletedSent} sent jobs`);
        }
        return this.syncService.syncUpcomingSessions({
          platform: this.platform,
          getSessions: this.getSessions,
        });
      },
    );

    if (result === null) {
      studyReminderLockSkipsTotal
        .labels({ platform: this.platform, scope: 'rollover' })
        .inc();
      if (this.options.logLockSkips) {
        this.logger.debug(
          'study-reminder-evening-rollover skipped — lock held by another pod',
        );
      }
    }
  }

  private async deleteSentJobsInternal(): Promise<number> {
    if (!this.jobRepository) return 0;
    return this.jobRepository.deleteSentJobs();
  }

  // ── Adaptive dispatch loop ──────────────────────────────────────────────

  private scheduleNextDispatch(delayMs: number): void {
    if (this.shuttingDown) return;
    this.dispatchTimer = setTimeout(() => {
      void this.runDispatchTick();
    }, delayMs);
    this.dispatchTimer.unref?.();
  }

  private async runDispatchTick(): Promise<void> {
    try {
      const result = await this.dispatchService.dispatchDueReminders();
      const settings = this.scheduleService.getDispatchSettings();
      const now = new Date();

      if (result.nextDueAt && result.nextDueAt > now) {
        const delay = Math.min(
          Math.max(
            result.nextDueAt.getTime() - now.getTime() - settings.pollLeadMs,
            settings.pollMinMs,
          ),
          settings.pollMaxMs,
        );
        this.scheduleNextDispatch(delay);
      } else {
        this.scheduleNextDispatch(settings.pollMinMs);
      }
    } catch (error) {
      this.logger.error(`Dispatch tick failed: ${this.toErrorMessage(error)}`);
      const settings = this.scheduleService.getDispatchSettings();
      this.scheduleNextDispatch(settings.pollMinMs);
    }
  }

  private toErrorMessage(error: unknown): string {
    return errorMessage(error);
  }
}
