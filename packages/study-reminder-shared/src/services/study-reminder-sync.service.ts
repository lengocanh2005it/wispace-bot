import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MAPPING_READER,
  type MappingReaderPort,
} from '../ports/mapping-reader.port';
import {
  STUDY_REMINDER_JOB_REPOSITORY,
  type StudyReminderJobRepositoryPort,
} from '../ports/study-reminder-job.repository.port';
import { StudyReminderScheduleService } from './study-reminder-schedule.service';
import type {
  UserLink,
  StudySessionRecord,
} from '../types/study-reminder.types';

const DEFAULT_PLATFORM = 'messenger';

export type OnUserSyncHook = (
  userId: number,
  platform: string,
) => Promise<void>;

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

  async syncUpcomingSessions(opts?: {
    userId?: number;
    platform?: string;
    getSessions?: (
      externalUserId: string,
      userId?: number,
    ) => Promise<StudySessionRecord[]>;
  }): Promise<{
    mappings: number;
    upserted: number;
    cancelled: number;
    skipped: number;
    failed: number;
  }> {
    const platform = opts?.platform ?? DEFAULT_PLATFORM;
    const settings = this.scheduleService.getOutboxSettings();
    const horizonEnd = new Date(
      Date.now() + settings.syncHorizonHours * 60 * 60 * 1000,
    );

    let mappings: UserLink[];
    if (opts?.userId) {
      const mapping =
        await this.mappingReader.findActiveMappingByExternalUserId(
          platform,
          String(opts.userId),
        );
      mappings = mapping ? [mapping] : [];
    } else {
      mappings = await this.mappingReader.findActiveMappings(platform);
    }

    let upserted = 0;
    let cancelled = 0;
    let skipped = 0;
    let failed = 0;

    for (const mapping of mappings) {
      try {
        // Cross-platform cancel hook (Messenger calls cancelJobsFromOtherPlatforms)
        if (opts?.userId && mapping.userId) {
          await this.onUserSync?.(mapping.userId, platform);
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
            maxRetries: this.getMaxRetries(),
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
          );
        cancelled += cancelledCount;
      } catch (error) {
        failed += 1;
        this.logger.warn(
          `Failed to sync for externalUserId=${mapping.externalUserId}: ${
            error instanceof Error
              ? error.message
              : typeof error === 'string'
                ? error
                : 'unknown error'
          }`,
        );
      }
    }

    this.logger.log(
      `Study reminder sync (all, platform=${platform}): mappings=${mappings.length}, upserted=${upserted}, cancelled=${cancelled}, skipped=${skipped}, failed=${failed}`,
    );

    return { mappings: mappings.length, upserted, cancelled, skipped, failed };
  }

  private getMaxRetries(): number {
    const raw = this.configService
      .get<string>('STUDY_REMINDER_MAX_RETRIES')
      ?.trim();
    if (!raw) return 3;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : 3;
  }

  private get configService(): ConfigService {
    return this.scheduleService['configService'];
  }
}
