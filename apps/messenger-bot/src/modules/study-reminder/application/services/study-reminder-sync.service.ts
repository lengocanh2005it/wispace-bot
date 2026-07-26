import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  MESSENGER_MAPPING_READER,
  type MessengerMappingReaderPort,
  type UserLink,
} from '../../../../shared/ports/messenger-mapping-reader.port';
import {
  STUDY_REMINDER_JOB_REPOSITORY,
  type StudyReminderJobRepositoryPort,
} from '../../domain/repositories/study-reminder-job.repository.port';
import { StudyReminderScheduleService } from './study-reminder-schedule.service';
import { StudySessionSourceService } from './study-session-source.service';

export interface StudyReminderSyncResult {
  scope: 'all' | 'user';
  userId?: number;
  linked: boolean;
  mappings: number;
  upserted: number;
  cancelled: number;
  skipped: number;
  failures: Array<{ psid: string; error: string }>;
}

@Injectable()
export class StudyReminderSyncService {
  private readonly logger = new Logger(StudyReminderSyncService.name);

  constructor(
    @Inject(MESSENGER_MAPPING_READER)
    private readonly messengerMappingReader: MessengerMappingReaderPort,
    private readonly studySessionSourceService: StudySessionSourceService,
    @Inject(STUDY_REMINDER_JOB_REPOSITORY)
    private readonly studyReminderJobRepository: StudyReminderJobRepositoryPort,
    private readonly studyReminderScheduleService: StudyReminderScheduleService,
  ) {}

  async syncUpcomingSessions(options?: {
    userId?: number;
  }): Promise<StudyReminderSyncResult> {
    const settings = this.studyReminderScheduleService.getOutboxSettings();
    const horizonEnd = new Date(
      Date.now() + settings.syncHorizonHours * 60 * 60 * 1000,
    );

    if (options?.userId) {
      return this.syncForUser(options.userId, horizonEnd, settings.maxRetries);
    }

    const mappings =
      await this.messengerMappingReader.findActiveMappingsWithPsid();
    const totals = await this.syncMappings(
      mappings,
      horizonEnd,
      settings.maxRetries,
    );

    this.logger.log(
      `Study reminder sync (all): mappings=${mappings.length}, upserted=${totals.upserted}, cancelled=${totals.cancelled}, skipped=${totals.skipped}, failed=${totals.failures.length}`,
    );

    return {
      scope: 'all',
      linked: true,
      mappings: mappings.length,
      ...totals,
    };
  }

  private async syncForUser(
    userId: number,
    horizonEnd: Date,
    maxRetries: number,
  ): Promise<StudyReminderSyncResult> {
    const mapping =
      await this.messengerMappingReader.findActiveMappingByUserId(userId);

    if (!mapping?.psid) {
      this.logger.log(
        `Study reminder sync skipped: userId=${userId} has no active Messenger mapping`,
      );

      return {
        scope: 'user',
        userId,
        linked: false,
        mappings: 0,
        upserted: 0,
        cancelled: 0,
        skipped: 1,
        failures: [],
      };
    }

    const totals = await this.syncMappings([mapping], horizonEnd, maxRetries);

    this.logger.log(
      `Study reminder sync (userId=${userId}): upserted=${totals.upserted}, cancelled=${totals.cancelled}, failed=${totals.failures.length}`,
    );

    return {
      scope: 'user',
      userId,
      linked: true,
      mappings: 1,
      ...totals,
    };
  }

  private async syncMappings(
    mappings: UserLink[],
    horizonEnd: Date,
    maxRetries: number,
  ): Promise<{
    upserted: number;
    cancelled: number;
    skipped: number;
    failures: Array<{ psid: string; error: string }>;
  }> {
    let upserted = 0;
    let cancelled = 0;
    let skipped = 0;
    const failures: Array<{ psid: string; error: string }> = [];

    for (const mapping of mappings) {
      if (!mapping.psid) {
        skipped += 1;
        continue;
      }

      try {
        const sessions =
          await this.studySessionSourceService.getUpcomingSessions({
            psid: mapping.psid,
            userId: mapping.userId,
            horizonEnd,
          });
        const activeSessionKeys: string[] = [];

        for (const session of sessions) {
          activeSessionKeys.push(session.sessionKey);
          const remindAt = this.studyReminderScheduleService.computeRemindAt(
            session.scheduledAt,
          );

          await this.studyReminderJobRepository.upsertPendingJob({
            psid: mapping.psid,
            userId: mapping.userId,
            sessionKey: session.sessionKey,
            scheduledAt: session.scheduledAt,
            remindAt,
            topic: session.topic,
            maxRetries,
          });
          upserted += 1;
        }

        cancelled +=
          await this.studyReminderJobRepository.cancelStaleJobsForPsid(
            mapping.psid,
            activeSessionKeys,
            horizonEnd,
          );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ psid: mapping.psid, error: message });
        this.logger.error(
          `Failed to sync study reminder jobs for PSID ${mapping.psid}`,
          error,
        );
      }
    }

    return { upserted, cancelled, skipped, failures };
  }
}
