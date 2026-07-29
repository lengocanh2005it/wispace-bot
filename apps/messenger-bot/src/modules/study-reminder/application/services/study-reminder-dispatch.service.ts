import { Inject, Injectable, Logger } from '@nestjs/common';
import { MetricsService } from '@messenger/modules/metrics/metrics.service';
import { MESSAGE_SENDER } from '@messenger/modules/messenger/application/ports/message-sender.port';
import type { MessageSenderPort } from '@messenger/modules/messenger/application/ports/message-sender.port';
import { shouldSkipProactiveRetries } from '@messenger/modules/messenger/application/utils/proactive-send.utils';
import { WispaceApiError } from '@messenger/shared/errors/wispace-api.error';
import {
  buildStudyReminderMessageType,
  jobToSession,
} from '../utils/study-reminder.utils';
import {
  STUDY_REMINDER_JOB_REPOSITORY,
  type StudyReminderJobRepositoryPort,
} from '../../domain/repositories/study-reminder-job.repository.port';
import { StudyReminderScheduleService } from './study-reminder-schedule.service';
import { StudyReminderService } from './study-reminder.service';

@Injectable()
export class StudyReminderDispatchService {
  private readonly logger = new Logger(StudyReminderDispatchService.name);

  constructor(
    @Inject(STUDY_REMINDER_JOB_REPOSITORY)
    private readonly studyReminderJobRepository: StudyReminderJobRepositoryPort,
    private readonly studyReminderScheduleService: StudyReminderScheduleService,
    private readonly studyReminderService: StudyReminderService,
    @Inject(MESSAGE_SENDER)
    private readonly messageSender: MessageSenderPort,
    private readonly metrics: MetricsService,
  ) {}

  async dispatchDueReminders(): Promise<{
    claimed: number;
    sent: number;
    cancelled: number;
    failed: number;
    retried: number;
    resetStuck: number;
    nextDueAt: Date | null;
    failures: Array<{ jobId: number; psid: string; error: string }>;
  }> {
    const settings = this.studyReminderScheduleService.getOutboxSettings();
    const now = new Date();
    const resetStuck =
      await this.studyReminderJobRepository.resetStuckProcessingJobs(
        new Date(now.getTime() - settings.stuckProcessingMs),
      );

    const dueJobs = await this.studyReminderJobRepository.findDueJobs(
      now,
      settings.minLeadMinutes,
    );

    // Pre-fetch display names in a single batch query to avoid N lazy DB reads
    // inside generateReminderForSession for each job.
    const uniqueUserIds = [
      ...new Set(
        dueJobs.map((j) => j.userId).filter((id): id is number => !!id),
      ),
    ];
    if (uniqueUserIds.length > 0) {
      await this.studyReminderService
        .preloadDisplayNames(uniqueUserIds)
        .catch((err: unknown) => {
          this.logger.warn(
            `Display name preload failed, continuing with lazy fallback: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
    }

    let claimed = 0;
    let sent = 0;
    let cancelled = 0;
    let failed = 0;
    let retried = 0;
    const failures: Array<{ jobId: number; psid: string; error: string }> = [];

    for (const dueJob of dueJobs) {
      const job = await this.studyReminderJobRepository.claimJob(dueJob.id);
      if (!job) {
        continue;
      }

      claimed += 1;

      if (
        this.studyReminderScheduleService.isSessionStarted(job.scheduledAt, now)
      ) {
        await this.studyReminderJobRepository.markCancelled(
          job.id,
          'session already started',
        );
        cancelled += 1;
        this.metrics.incReminderDispatch('cancelled');
        continue;
      }

      try {
        const session = jobToSession(job);
        const messageType = buildStudyReminderMessageType(session);
        const reminder =
          await this.studyReminderService.generateReminderForSession(
            job.psid,
            session,
            { userId: job.userId, jobId: job.id },
          );
        await this.messageSender.sendTextViaPsid({
          psid: job.psid,
          userId: job.userId,
          text: reminder,
          messageType,
        });
        await this.studyReminderJobRepository.markSent(job.id);
        sent += 1;
        this.metrics.incReminderDispatch('sent');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const nextRetryCount = job.retryCount + 1;
        const is24hWindow = shouldSkipProactiveRetries(error);
        const isNonRetryableWispace =
          error instanceof WispaceApiError && !error.isRetryable();
        const terminal =
          is24hWindow ||
          isNonRetryableWispace ||
          nextRetryCount >= job.maxRetries;
        const errorMessage = is24hWindow
          ? 'Messenger 24h messaging window closed'
          : message;

        if (is24hWindow) {
          this.logger.warn(
            `MESSENGER_24H_WINDOW psid=${job.psid} jobId=${job.id} study_reminder`,
          );
        }

        if (isNonRetryableWispace) {
          this.logger.warn(
            `WISPACE_NON_RETRYABLE psid=${job.psid} jobId=${job.id} status=${error.statusCode}; marking terminal`,
          );
        }

        if (terminal) {
          await this.studyReminderJobRepository.markFailed({
            jobId: job.id,
            errorMessage,
            retryCount: nextRetryCount,
            terminal: true,
          });
          failed += 1;
          this.metrics.incReminderDispatch('failed');
        } else {
          const nextRetryAt = new Date(
            now.getTime() + settings.retryBackoffMinutes * 60 * 1000,
          );
          await this.studyReminderJobRepository.markFailed({
            jobId: job.id,
            errorMessage,
            retryCount: nextRetryCount,
            nextRetryAt,
            terminal: false,
          });
          retried += 1;
          this.metrics.incReminderDispatch('retried');
        }

        failures.push({
          jobId: job.id,
          psid: job.psid,
          error: errorMessage,
        });
        this.logger.error(
          `Failed to dispatch study reminder job ${job.id} for PSID ${job.psid}`,
          error,
        );
      }
    }

    if (claimed > 0 || resetStuck > 0) {
      this.logger.log(
        `Study reminder dispatch: claimed=${claimed}, sent=${sent}, cancelled=${cancelled}, retried=${retried}, failed=${failed}, resetStuck=${resetStuck}`,
      );
    }

    const nextDueAt = await this.studyReminderJobRepository
      .findNextDueTime(now)
      .catch(() => null);

    return {
      claimed,
      sent,
      cancelled,
      failed,
      retried,
      resetStuck,
      nextDueAt,
      failures,
    };
  }
}
