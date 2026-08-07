import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  STUDY_REMINDER_JOB_REPOSITORY,
  type StudyReminderJobRepositoryPort,
} from '../ports/study-reminder-job.repository.port';
import {
  MESSAGE_SENDER,
  type MessageSenderPort,
} from '../ports/message-sender.port';
import {
  REMINDER_GENERATOR,
  type ReminderGeneratorPort,
} from '../ports/reminder-generator.port';
import { METRICS_HOOK, type MetricsHook } from '../ports/metrics-hook.port';
import {
  ERROR_CLASSIFIER,
  type ErrorClassifierPort,
} from '../ports/error-classifier.port';
import { StudyReminderScheduleService } from './study-reminder-schedule.service';
import type { StudyReminderJob } from '../types/study-reminder.types';

export interface StudyReminderDispatchFailure {
  jobId: number;
  externalUserId: string;
  error: string;
}

export interface StudyReminderDispatchResult {
  claimed: number;
  sent: number;
  cancelled: number;
  retried: number;
  failed: number;
  resetStuck: number;
  nextDueAt: Date | null;
  failures: StudyReminderDispatchFailure[];
}

export interface StudyReminderDispatchServiceOptions {
  /**
   * 'exponential' (default): backoff grows 2^retryCount.
   * 'flat' (Messenger): fixed retryBackoffMinutes between attempts.
   */
  backoffMode?: 'exponential' | 'flat';
  /**
   * Messenger: batch display-name warm-up before dispatching (single query
   * instead of N lazy DB reads). Errors are logged and ignored.
   */
  preloadDisplayNames?: (userIds: number[]) => Promise<void>;
  /**
   * Messenger: classifies a send failure as terminal (24h window, non-retryable
   * Wispace error) and normalizes the persisted error message. When it returns
   * a value, it fully overrides the default classification.
   */
  classifyFailure?: (params: {
    error: unknown;
    job: StudyReminderJob;
  }) => { terminal: boolean; errorMessage: string } | undefined;
}

@Injectable()
export class StudyReminderDispatchService {
  private readonly logger = new Logger(StudyReminderDispatchService.name);

  constructor(
    @Inject(STUDY_REMINDER_JOB_REPOSITORY)
    private readonly jobRepository: StudyReminderJobRepositoryPort,
    @Inject(MESSAGE_SENDER)
    private readonly messageSender: MessageSenderPort,
    private readonly scheduleService: StudyReminderScheduleService,
    @Optional()
    @Inject(REMINDER_GENERATOR)
    private readonly reminderGenerator?: ReminderGeneratorPort,
    @Optional()
    @Inject(METRICS_HOOK)
    private readonly metrics?: MetricsHook,
    @Optional()
    @Inject(ERROR_CLASSIFIER)
    private readonly errorClassifier?: ErrorClassifierPort,
    @Optional() private readonly options?: StudyReminderDispatchServiceOptions,
  ) {}

  async dispatchDueReminders(): Promise<StudyReminderDispatchResult> {
    const settings = this.scheduleService.getOutboxSettings();
    const now = new Date();

    const resetStuck = await this.jobRepository.resetStuckProcessingJobs(
      new Date(now.getTime() - settings.stuckProcessingMs),
    );

    const dueJobs = await this.jobRepository.findDueJobs(
      now,
      settings.minLeadMinutes,
    );

    // Pre-fetch display names in a single batch query to avoid N lazy DB reads.
    const uniqueUserIds = [
      ...new Set(
        dueJobs.map((j) => j.userId).filter((id): id is number => !!id),
      ),
    ];
    if (uniqueUserIds.length > 0 && this.options?.preloadDisplayNames) {
      try {
        await this.options.preloadDisplayNames(uniqueUserIds);
      } catch (error) {
        this.logger.warn(
          `Display name preload failed, continuing with lazy fallback: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    let claimed = 0;
    let sent = 0;
    let cancelled = 0;
    let retried = 0;
    let failed = 0;
    const failures: StudyReminderDispatchFailure[] = [];

    for (const job of dueJobs) {
      const claimedJob = await this.jobRepository.claimJob(job.id);
      if (!claimedJob) continue;

      claimed += 1;

      if (this.scheduleService.isSessionStarted(claimedJob.scheduledAt, now)) {
        await this.jobRepository.markCancelled(
          claimedJob.id,
          'session already started',
        );
        this.metrics?.onCancelled?.({
          jobId: claimedJob.id,
          externalUserId: claimedJob.externalUserId,
        });
        cancelled += 1;
        continue;
      }

      try {
        const timeLabel = this.scheduleService.formatScheduledTimeLabel(
          claimedJob.scheduledAt,
        );
        const minutesUntil = this.scheduleService.getMinutesUntilSession(
          claimedJob.scheduledAt,
          now,
        );

        const text = await this.buildReminderText(
          claimedJob,
          timeLabel,
          minutesUntil,
        );

        await this.messageSender.sendText({
          externalUserId: claimedJob.externalUserId,
          text,
          messageType: 'STUDY_REMINDER',
          userId: claimedJob.userId,
        });

        await this.jobRepository.markSent(claimedJob.id);
        this.metrics?.onSent?.({
          jobId: claimedJob.id,
          externalUserId: claimedJob.externalUserId,
        });
        sent += 1;
      } catch (error) {
        const errorMsg = this.toErrorMessage(error);

        const classification = this.options?.classifyFailure?.({
          error,
          job: claimedJob,
        });
        const terminal = classification
          ? classification.terminal
          : (this.errorClassifier?.isTerminal(error) ??
            claimedJob.retryCount + 1 >= claimedJob.maxRetries);
        const errorMessage = classification?.errorMessage ?? errorMsg;

        const nextRetryCount = claimedJob.retryCount + 1;
        const backoffMs = settings.retryBackoffMinutes * 60 * 1000;
        const nextRetryAt = terminal
          ? undefined
          : new Date(
              now.getTime() +
                (this.options?.backoffMode === 'flat'
                  ? backoffMs
                  : backoffMs * Math.pow(2, claimedJob.retryCount)),
            );

        await this.jobRepository.markFailed({
          jobId: claimedJob.id,
          errorMessage,
          retryCount: nextRetryCount,
          nextRetryAt,
          terminal,
        });
        failures.push({
          jobId: claimedJob.id,
          externalUserId: claimedJob.externalUserId,
          error: errorMessage,
        });

        if (terminal) {
          failed += 1;
          this.metrics?.onFailed?.({
            jobId: claimedJob.id,
            externalUserId: claimedJob.externalUserId,
            error: errorMessage,
          });
          this.logger.warn(
            `Study reminder job failed terminal jobId=${claimedJob.id} externalUserId=${claimedJob.externalUserId}: ${errorMessage}`,
          );
        } else {
          retried += 1;
          this.metrics?.onRetried?.({
            jobId: claimedJob.id,
            externalUserId: claimedJob.externalUserId,
            retryCount: nextRetryCount,
          });
          this.logger.warn(
            `Study reminder job retry jobId=${claimedJob.id} externalUserId=${claimedJob.externalUserId} retry=${nextRetryCount}/${claimedJob.maxRetries}: ${errorMessage}`,
          );
        }
      }
    }

    const nextDueAt = await this.jobRepository
      .findNextDueTime(now)
      .catch((error) => {
        this.logger.warn(
          `findNextDueTime failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      });

    if (claimed > 0 || resetStuck > 0) {
      this.logger.log(
        `Study reminder dispatch: claimed=${claimed}, sent=${sent}, cancelled=${cancelled}, retried=${retried}, failed=${failed}, resetStuck=${resetStuck}`,
      );
    }

    return {
      claimed,
      sent,
      cancelled,
      retried,
      failed,
      resetStuck,
      nextDueAt,
      failures,
    };
  }

  private async buildReminderText(
    job: StudyReminderJob,
    timeLabel: string,
    minutesUntil: number,
  ): Promise<string> {
    if (this.reminderGenerator) {
      return this.reminderGenerator.generate(
        {
          calendarId: job.sessionKey,
          sessionKey: job.sessionKey,
          scheduledAt: job.scheduledAt,
          topic: job.topic,
        },
        {
          externalUserId: job.externalUserId,
          userId: job.userId,
          timeLabel,
          minutesUntil,
          jobId: job.id,
        },
      );
    }

    const topic = job.topic || 'học tập';
    return `Nhắc lịch: Bạn có lịch ${topic} lúc ${timeLabel} (còn ${minutesUntil} phút).`;
  }

  private toErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    return 'unknown error';
  }
}
