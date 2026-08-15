import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { errorMessage, maskExternalId } from '@wispace/bot-common';
import { runBatched } from '@wispace/scheduler-core';
import {
  MAPPING_READER,
  type MappingReaderPort,
} from '../ports/mapping-reader.port';
import {
  STUDY_REMINDER_JOB_REPOSITORY,
  type StudyReminderJobRepositoryPort,
  type UpsertStudyReminderJobInput,
} from '../ports/study-reminder-job.repository.port';
import { StudyReminderScheduleService } from './study-reminder-schedule.service';
import { hoursFromNow } from '@wispace/date-utils';
import type {
  StudyReminderJobStatus,
  StudyReminderSyncFailure,
  StudyReminderSyncResult,
  UserLink,
  StudySessionRecord,
} from '../types/study-reminder.types';
import type { Platform } from '@wispace/database';

const DEFAULT_PLATFORM = 'messenger';
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_SYNC_CONCURRENCY = 5;

export type OnUserSyncHook = (
  userId: number,
  platform: Platform,
) => Promise<number | void>;

export interface StudyReminderSyncOptions {
  userId?: number;
  platform?: Platform;
  getSessions?: (
    externalUserId: string,
    userId?: number,
  ) => Promise<StudySessionRecord[]>;
  /**
   * Messenger: resolves the mapping by WISPACE userId (its ops flow syncs by
   * userId, not by external id). Falls back to findActiveMappingByExternalUserId.
   */
  userIdMappingLookup?: (userId: number) => Promise<UserLink | null>;
  /** Statuses considered stale when cancelling out-of-horizon jobs (Messenger adds 'processing'). */
  staleCancelStatuses?: StudyReminderJobStatus[];
}

interface SyncSettings {
  maxRetries: number;
  syncHorizonHours: number;
}

interface SyncCounters {
  mappings: number;
  skipped: number;
  upserted: number;
  cancelled: number;
  failed: number;
  cancelledOtherPlatforms: number;
  failures: StudyReminderSyncFailure[];
}

interface PerMappingOutcome {
  upserted: number;
  cancelled: number;
  skipped: number;
  cancelledOtherPlatforms?: number;
  failure?: StudyReminderSyncFailure;
}

@Injectable()
export class StudyReminderSyncService {
  private readonly logger = new Logger(StudyReminderSyncService.name);
  private readonly onUserSync?: OnUserSyncHook;

  constructor(
    @Inject(MAPPING_READER)
    private readonly mappingReader: MappingReaderPort,
    @Inject(STUDY_REMINDER_JOB_REPOSITORY)
    private readonly jobRepository: StudyReminderJobRepositoryPort,
    private readonly scheduleService: StudyReminderScheduleService,
    @Optional() onUserSync?: OnUserSyncHook,
  ) {
    this.onUserSync = onUserSync;
  }

  async syncUpcomingSessions(
    opts?: StudyReminderSyncOptions,
  ): Promise<StudyReminderSyncResult> {
    const platform = opts?.platform ?? DEFAULT_PLATFORM;

    // Fail closed: without an authoritative session provider we would treat
    // the calendar as empty and cancel every stale job. Every entry point
    // must supply a real getSessions — missing = programming error.
    const getSessions = opts?.getSessions;
    if (!getSessions) {
      throw new Error(
        'Study reminder sync requires an authoritative getSessions provider — refusing to cancel jobs from an empty session list',
      );
    }

    const settings = this.scheduleService.getOutboxSettings();
    const horizonEnd = hoursFromNow(settings.syncHorizonHours);
    const startedAt = Date.now();
    const counters: SyncCounters = {
      mappings: 0,
      skipped: 0,
      upserted: 0,
      cancelled: 0,
      failed: 0,
      cancelledOtherPlatforms: 0,
      failures: [],
    };
    let linked = true;

    if (opts?.userId) {
      const mapping = opts.userIdMappingLookup
        ? await opts.userIdMappingLookup(opts.userId)
        : await this.mappingReader.findActiveMappingByExternalUserId(
            platform,
            String(opts.userId),
          );
      linked = mapping != null;
      if (!mapping) {
        // Messenger reports an unlinked userId as one skipped mapping.
        counters.skipped = 1;
      } else {
        counters.mappings = 1;
        this.accumulate(
          await this.syncOneMapping(
            mapping,
            platform,
            opts,
            settings,
            horizonEnd,
          ),
          counters,
        );
      }
    } else {
      // Keyset-paged full sync: bounded memory and bounded concurrency, so
      // duration no longer grows one serial upstream fetch per user.
      let afterId: string | undefined;
      let pageNo = 0;
      let pageProcessed: number;
      do {
        const page = await this.mappingReader.findActiveMappingsPage(platform, {
          limit: DEFAULT_PAGE_SIZE,
          afterId,
        });
        pageProcessed = page.items.length;
        counters.mappings += pageProcessed;
        pageNo += 1;

        const results = await runBatched(
          page.items,
          DEFAULT_SYNC_CONCURRENCY,
          (mapping) =>
            this.syncOneMapping(mapping, platform, opts, settings, horizonEnd),
        );

        let batchUpserted = 0;
        let batchCancelled = 0;
        for (const result of results) {
          if (result.status !== 'fulfilled') {
            counters.failed += 1;
            continue;
          }
          const outcome = result.value as PerMappingOutcome;
          batchUpserted += outcome.upserted;
          batchCancelled += outcome.cancelled;
          this.accumulate(outcome, counters);
        }

        this.logger.log(
          `Study reminder sync batch ${pageNo} (platform=${platform}): processed=${pageProcessed}, upserted=${batchUpserted}, cancelled=${batchCancelled}, totalProcessed=${counters.mappings}`,
        );

        afterId = page.nextId;
      } while (afterId !== undefined && pageProcessed === DEFAULT_PAGE_SIZE);
    }

    this.logger.log(
      `Study reminder sync (all, platform=${platform}): mappings=${counters.mappings}, upserted=${counters.upserted}, cancelled=${counters.cancelled}, skipped=${counters.skipped}, failed=${counters.failed} (${Date.now() - startedAt}ms)`,
    );

    return {
      mappings: counters.mappings,
      upserted: counters.upserted,
      cancelled: counters.cancelled,
      skipped: counters.skipped,
      failed: counters.failed,
      scope: opts?.userId ? 'user' : 'all',
      userId: opts?.userId,
      linked,
      cancelledOtherPlatforms: counters.cancelledOtherPlatforms,
      failures: counters.failures,
    };
  }

  /**
   * Sync one mapping: cross-platform cancel hook, upstream session fetch,
   * batched upsert, stale-job cancellation. Never throws — per-user failures
   * are isolated and reported through the outcome (same contract as before).
   */
  private async syncOneMapping(
    mapping: UserLink,
    platform: Platform,
    opts: StudyReminderSyncOptions,
    settings: SyncSettings,
    horizonEnd: Date,
  ): Promise<PerMappingOutcome> {
    if (!mapping.externalUserId) {
      return { upserted: 0, cancelled: 0, skipped: 1 };
    }

    try {
      let cancelledOtherPlatforms = 0;
      // Cross-platform cancel hook (Messenger cancels jobs from other platforms)
      if (opts.userId && mapping.userId) {
        const cancelledCount = await this.onUserSync?.(
          mapping.userId,
          platform,
        );
        if (typeof cancelledCount === 'number') {
          cancelledOtherPlatforms = cancelledCount;
        }
      }

      const sessions = await opts.getSessions!(
        mapping.externalUserId,
        mapping.userId,
      );

      const activeSessionKeys: string[] = [];
      const batch: UpsertStudyReminderJobInput[] = [];
      let skipped = 0;

      for (const session of sessions) {
        if (session.scheduledAt > horizonEnd) {
          skipped += 1;
          continue;
        }

        const remindAt = this.scheduleService.computeRemindAt(
          session.scheduledAt,
        );

        batch.push({
          platform,
          externalUserId: mapping.externalUserId,
          userId: mapping.userId,
          sessionKey: session.sessionKey,
          scheduledAt: session.scheduledAt,
          remindAt,
          topic: session.topic,
          maxRetries: settings.maxRetries,
        });

        activeSessionKeys.push(session.sessionKey);
      }

      if (batch.length > 0) {
        // One SELECT + batched save instead of findOne+save per session.
        await this.jobRepository.upsertPendingJobs(batch, {
          // Leave in-flight `processing` jobs alone unless the schedule
          // actually changed — prevents a 30-min sync from reopening a job
          // mid-send and causing duplicate reminders on multi-pod setups.
          reopenOnlyOnScheduleChange: true,
        });
      }

      const cancelledCount =
        await this.jobRepository.cancelStaleJobsForExternalUserId(
          platform,
          mapping.externalUserId,
          activeSessionKeys,
          horizonEnd,
          opts?.staleCancelStatuses
            ? { statuses: opts.staleCancelStatuses }
            : undefined,
        );

      return {
        upserted: batch.length,
        cancelled: cancelledCount,
        skipped,
        cancelledOtherPlatforms,
      };
    } catch (error) {
      this.logger.warn(
        `Failed to sync for externalUserId=${maskExternalId(
          mapping.externalUserId,
        )}: ${this.toErrorMessage(error)}`,
      );
      return {
        upserted: 0,
        cancelled: 0,
        skipped: 0,
        failure: {
          externalUserId: mapping.externalUserId,
          error: this.toErrorMessage(error),
        },
      };
    }
  }

  private accumulate(outcome: PerMappingOutcome, counters: SyncCounters): void {
    counters.skipped += outcome.skipped;
    counters.upserted += outcome.upserted;
    counters.cancelled += outcome.cancelled;
    counters.cancelledOtherPlatforms += outcome.cancelledOtherPlatforms ?? 0;
    if (outcome.failure) {
      counters.failed += 1;
      counters.failures.push(outcome.failure);
    }
  }

  private toErrorMessage(error: unknown): string {
    return errorMessage(error);
  }
}
