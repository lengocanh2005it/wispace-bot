import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  MAPPING_READER,
  type MappingReaderPort,
} from '../ports/mapping-reader.port';
import {
  STUDY_REMINDER_JOB_REPOSITORY,
  type StudyReminderJobRepositoryPort,
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

const DEFAULT_PLATFORM = 'messenger';

export type OnUserSyncHook = (
  userId: number,
  platform: string,
) => Promise<number | void>;

export interface StudyReminderSyncOptions {
  userId?: number;
  platform?: string;
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
    const settings = this.scheduleService.getOutboxSettings();
    const horizonEnd = hoursFromNow(settings.syncHorizonHours);

    let mappings: UserLink[];
    let linked = true;
    let skipped = 0;
    if (opts?.userId) {
      const mapping = opts.userIdMappingLookup
        ? await opts.userIdMappingLookup(opts.userId)
        : await this.mappingReader.findActiveMappingByExternalUserId(
            platform,
            String(opts.userId),
          );
      mappings = mapping ? [mapping] : [];
      linked = mapping != null;
      if (!mapping) {
        // Messenger reports an unlinked userId as one skipped mapping.
        skipped = 1;
      }
    } else {
      mappings = await this.mappingReader.findActiveMappings(platform);
    }

    let upserted = 0;
    let cancelled = 0;
    let failed = 0;
    let cancelledOtherPlatforms = 0;
    const failures: StudyReminderSyncFailure[] = [];

    for (const mapping of mappings) {
      if (!mapping.externalUserId) {
        skipped += 1;
        continue;
      }

      try {
        // Cross-platform cancel hook (Messenger cancels jobs from other platforms)
        if (opts?.userId && mapping.userId) {
          const cancelledCount = await this.onUserSync?.(
            mapping.userId,
            platform,
          );
          if (typeof cancelledCount === 'number') {
            cancelledOtherPlatforms += cancelledCount;
          }
        }

        const sessions = opts?.getSessions
          ? await opts.getSessions(mapping.externalUserId, mapping.userId)
          : [];

        const activeSessionKeys: string[] = [];

        for (const session of sessions) {
          if (session.scheduledAt > horizonEnd) {
            skipped += 1;
            continue;
          }

          const remindAt = this.scheduleService.computeRemindAt(
            session.scheduledAt,
          );

          await this.jobRepository.upsertPendingJob({
            platform,
            externalUserId: mapping.externalUserId,
            userId: mapping.userId,
            sessionKey: session.sessionKey,
            scheduledAt: session.scheduledAt,
            remindAt,
            topic: session.topic,
            maxRetries: settings.maxRetries,
          });

          upserted += 1;
          activeSessionKeys.push(session.sessionKey);
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
        cancelled += cancelledCount;
      } catch (error) {
        failed += 1;
        failures.push({
          externalUserId: mapping.externalUserId,
          error: this.toErrorMessage(error),
        });
        this.logger.warn(
          `Failed to sync for externalUserId=${mapping.externalUserId}: ${this.toErrorMessage(error)}`,
        );
      }
    }

    this.logger.log(
      `Study reminder sync (all, platform=${platform}): mappings=${mappings.length}, upserted=${upserted}, cancelled=${cancelled}, skipped=${skipped}, failed=${failed}`,
    );

    return {
      mappings: mappings.length,
      upserted,
      cancelled,
      skipped,
      failed,
      scope: opts?.userId ? 'user' : 'all',
      userId: opts?.userId,
      linked,
      cancelledOtherPlatforms,
      failures,
    };
  }

  private toErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    return 'unknown error';
  }
}
