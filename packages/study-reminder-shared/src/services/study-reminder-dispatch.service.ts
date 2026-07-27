import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MAPPING_READER,
  type MappingReaderPort,
} from '../ports/mapping-reader.port';
import {
  STUDY_REMINDER_JOB_REPOSITORY,
  type StudyReminderJobRepositoryPort,
} from '../ports/study-reminder-job.repository.port';
import {
  MESSAGE_SENDER,
  type MessageSenderPort,
} from '../ports/message-sender.port';
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
    @Inject(MAPPING_READER)
    private readonly mappingReader: MappingReaderPort,
    private readonly scheduleService: StudyReminderScheduleService,
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
        await this.jobRepository.markCancelled(claimedJob.id);
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

        const text = this.buildReminderText(
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
        sent += 1;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);

        const nextRetryCount = claimedJob.retryCount + 1;
        const terminal = nextRetryCount >= claimedJob.maxRetries;

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
          this.logger.warn(
            `Study reminder job failed terminal jobId=${claimedJob.id} externalUserId=${claimedJob.externalUserId}: ${errorMsg}`,
          );
        } else {
          retried += 1;
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

  private buildReminderText(
    job: StudyReminderJob,
    timeLabel: string,
    minutesUntil: number,
  ): string {
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
