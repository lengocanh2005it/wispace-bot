import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
  ) {}

  async dispatchDueReminders(): Promise<{
    claimed: number;
    sent: number;
    cancelled: number;
    retried: number;
    failed: number;
    resetStuck: number;
    nextDueAt: Date | null;
  }> {
    const settings = this.scheduleService.getOutboxSettings();
    const now = new Date();

    const resetStuck = await this.jobRepository.resetStuckProcessingJobs(
      new Date(now.getTime() - settings.stuckProcessingMs),
    );

    const dueJobs = await this.jobRepository.findDueJobs(
      now,
      settings.minLeadMinutes,
    );

    let claimed = 0;
    let sent = 0;
    let cancelled = 0;
    let retried = 0;
    let failed = 0;

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
        const errorMsg =
          error instanceof Error
            ? error.message
            : typeof error === 'string'
              ? error
              : 'unknown error';

        // Check if error is terminal (no retry)
        const terminal =
          this.errorClassifier?.isTerminal(error) ??
          claimedJob.retryCount + 1 >= claimedJob.maxRetries;

        const nextRetryCount = claimedJob.retryCount + 1;
        const nextRetryAt = terminal
          ? undefined
          : new Date(
              now.getTime() +
                this.getRetryBackoffMs() * Math.pow(2, claimedJob.retryCount),
            );

        await this.jobRepository.markFailed({
          jobId: claimedJob.id,
          errorMessage: errorMsg,
          retryCount: nextRetryCount,
          nextRetryAt,
          terminal,
        });

        if (terminal) {
          failed += 1;
          this.metrics?.onFailed?.({
            jobId: claimedJob.id,
            externalUserId: claimedJob.externalUserId,
            error: errorMsg,
          });
          this.logger.warn(
            `Study reminder job failed terminal jobId=${claimedJob.id} externalUserId=${claimedJob.externalUserId}: ${errorMsg}`,
          );
        } else {
          retried += 1;
          this.metrics?.onRetried?.({
            jobId: claimedJob.id,
            externalUserId: claimedJob.externalUserId,
            retryCount: nextRetryCount,
          });
          this.logger.warn(
            `Study reminder job retry jobId=${claimedJob.id} externalUserId=${claimedJob.externalUserId} retry=${nextRetryCount}/${claimedJob.maxRetries}: ${errorMsg}`,
          );
        }
      }
    }

    const nextDueAt = await this.jobRepository.findNextDueTime(now);

    if (claimed > 0 || resetStuck > 0) {
      this.logger.log(
        `Study reminder dispatch: claimed=${claimed}, sent=${sent}, cancelled=${cancelled}, retried=${retried}, failed=${failed}, resetStuck=${resetStuck}`,
      );
    }

    return { claimed, sent, cancelled, retried, failed, resetStuck, nextDueAt };
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
        },
      );
    }

    const topic = job.topic || 'học tập';
    return `Nhắc lịch: Bạn có lịch ${topic} lúc ${timeLabel} (còn ${minutesUntil} phút).`;
  }

  private getRetryBackoffMs(): number {
    const raw = this.configService
      .get<string>('STUDY_REMINDER_RETRY_BACKOFF_MINUTES')
      ?.trim();
    if (!raw) return 2 * 60 * 1000;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0
      ? value * 60 * 1000
      : 2 * 60 * 1000;
  }

  private get configService(): ConfigService {
    return this.scheduleService['configService'];
  }
}
