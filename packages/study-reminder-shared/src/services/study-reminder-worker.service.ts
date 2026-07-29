import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { Cron, SchedulerRegistry } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { StudyReminderSyncService } from './study-reminder-sync.service';
import { StudyReminderDispatchService } from './study-reminder-dispatch.service';
import { StudyReminderScheduleService } from './study-reminder-schedule.service';
import {
  STUDY_REMINDER_JOB_REPOSITORY,
  type StudyReminderJobRepositoryPort,
} from '../ports/study-reminder-job.repository.port';
import type { GetSessionsFn } from '../types/study-reminder.types';

const ADVISORY_LOCK_SYNC = 884_200_901;
const ADVISORY_LOCK_CLEANUP = 884_200_902;

@Injectable()
export class StudyReminderWorkerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(StudyReminderWorkerService.name);
  private dispatchTimer: ReturnType<typeof setTimeout> | null = null;
  private shuttingDown = false;
  private readonly platform: string;
  private readonly getSessions?: GetSessionsFn;

  constructor(
    private readonly syncService: StudyReminderSyncService,
    private readonly dispatchService: StudyReminderDispatchService,
    private readonly scheduleService: StudyReminderScheduleService,
    private readonly schedulerRegistry: SchedulerRegistry,
    @InjectDataSource() private readonly dataSource: DataSource,
    @Optional()
    @Inject(STUDY_REMINDER_JOB_REPOSITORY)
    private readonly jobRepository?: StudyReminderJobRepositoryPort,
    platform: string = 'messenger',
    getSessions?: GetSessionsFn,
  ) {
    this.platform = platform;
    this.getSessions = getSessions;
  }

  async onModuleInit(): Promise<void> {
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
      this.schedulerRegistry.deleteCronJob('study-reminder-evening-rollover');
    } catch {
      // ignore if not registered
    }
  }

  // ── Public convenience methods ──────────────────────────────────────────

  async runSync(): Promise<void> {
    await this.runInitialSync();
  }

  async runDispatch(): Promise<void> {
    await this.runDispatchTick();
  }

  async runCleanup(): Promise<void> {
    await this.handleCleanupCron();
  }

  async runSyncAndDispatch(): Promise<void> {
    await this.runInitialSync();
    await this.runDispatchTick();
  }

  // ── Initial sync ────────────────────────────────────────────────────────

  private async runInitialSync(): Promise<void> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    try {
      const rows = (await runner.query(
        'SELECT pg_try_advisory_lock($1::bigint) AS acquired',
        [ADVISORY_LOCK_SYNC],
      )) as Array<{ acquired: boolean }>;
      if (!rows[0]?.acquired) {
        this.logger.log('Study reminder sync skipped — another pod holds lock');
        return;
      }
      try {
        await this.syncService.syncUpcomingSessions({
          platform: this.platform,
          getSessions: this.getSessions,
        });
      } finally {
        await runner.query('SELECT pg_advisory_unlock($1::bigint)', [
          ADVISORY_LOCK_SYNC,
        ]);
      }
    } finally {
      await runner.release();
    }
  }

  // ── Sync cron (every 30 min) ────────────────────────────────────────────

  @Cron('0 */30 * * * *', {
    name: 'study-reminder-sync',
    timeZone: 'Asia/Ho_Chi_Minh',
  })
  async handleSyncCron(): Promise<void> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    try {
      const rows = (await runner.query(
        'SELECT pg_try_advisory_lock($1::bigint) AS acquired',
        [ADVISORY_LOCK_SYNC],
      )) as Array<{ acquired: boolean }>;
      if (!rows[0]?.acquired) return;
      try {
        await this.syncService.syncUpcomingSessions({
          platform: this.platform,
          getSessions: this.getSessions,
        });
      } finally {
        await runner.query('SELECT pg_advisory_unlock($1::bigint)', [
          ADVISORY_LOCK_SYNC,
        ]);
      }
    } finally {
      await runner.release();
    }
  }

  // ── Cleanup cron (03:00 ICT) ────────────────────────────────────────────

  @Cron('0 0 3 * * *', {
    name: 'study-reminder-cleanup',
    timeZone: 'Asia/Ho_Chi_Minh',
  })
  async handleCleanupCron(): Promise<void> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    try {
      const rows = (await runner.query(
        'SELECT pg_try_advisory_lock($1::bigint) AS acquired',
        [ADVISORY_LOCK_CLEANUP],
      )) as Array<{ acquired: boolean }>;
      if (!rows[0]?.acquired) return;
      try {
        if (this.jobRepository) {
          const settings = this.scheduleService.getOutboxSettings();
          const retentionMs = settings.jobRetentionDays * 24 * 60 * 60 * 1000;
          const cutoff = new Date(Date.now() - retentionMs);
          const deleted =
            await this.jobRepository.deleteTerminalJobsOlderThan(cutoff);
          if (deleted > 0) {
            this.logger.log(
              `Cleanup: deleted ${deleted} terminal jobs older than ${settings.jobRetentionDays} days`,
            );
          }
        }
      } finally {
        await runner.query('SELECT pg_advisory_unlock($1::bigint)', [
          ADVISORY_LOCK_CLEANUP,
        ]);
      }
    } finally {
      await runner.release();
    }
  }

  // ── Evening rollover cron (23:00 ICT) ──────────────────────────────────

  @Cron('0 0 23 * * *', {
    name: 'study-reminder-evening-rollover',
    timeZone: 'Asia/Ho_Chi_Minh',
  })
  async handleEveningRollover(): Promise<void> {
    if (!this.jobRepository) return;

    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    try {
      const rows = (await runner.query(
        'SELECT pg_try_advisory_lock($1::bigint) AS acquired',
        [ADVISORY_LOCK_CLEANUP],
      )) as Array<{ acquired: boolean }>;
      if (!rows[0]?.acquired) return;
      try {
        const deleted = await this.jobRepository.deleteSentJobs(new Date());
        if (deleted > 0) {
          this.logger.log(`Evening rollover: purged ${deleted} sent jobs`);
        }
        await this.syncService.syncUpcomingSessions({
          platform: this.platform,
          getSessions: this.getSessions,
        });
      } finally {
        await runner.query('SELECT pg_advisory_unlock($1::bigint)', [
          ADVISORY_LOCK_CLEANUP,
        ]);
      }
    } finally {
      await runner.release();
    }
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
      this.logger.error(
        `Dispatch tick failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      const settings = this.scheduleService.getDispatchSettings();
      this.scheduleNextDispatch(settings.pollMinMs);
    }
  }
}
