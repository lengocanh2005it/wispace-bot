import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { errorMessage, maskExternalId } from '@wispace/bot-common';
import type { OutboundDeliveryOutcome } from '@wispace/database';
import {
  STUDY_REMINDER_JOB_REPOSITORY,
  type StudyReminderJobRepositoryPort,
} from '../ports/study-reminder-job.repository.port';
import {
  MESSAGE_SENDER,
  type MessageSenderPort,
} from '../ports/message-sender.port';
import {
  DISPATCH_HOOKS,
  type DispatchHooksPort,
} from '../ports/dispatch-hooks.port';
import { StudyReminderScheduleService } from './study-reminder-schedule.service';
import { subtractMs } from '@wispace/date-utils';
import type { Platform } from '@wispace/database';
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
    /** The worker's own platform — every due/claim/reset query is scoped to it (#180). */
    private readonly platform: Platform,
    @Optional()
    @Inject(DISPATCH_HOOKS)
    private readonly hooks?: DispatchHooksPort,
    @Optional() private readonly options?: StudyReminderDispatchServiceOptions,
  ) {}

  async dispatchDueReminders(): Promise<StudyReminderDispatchResult> {
    const settings = this.scheduleService.getOutboxSettings();
    const now = new Date();

    const resetStuck = await this.jobRepository.resetStuckProcessingJobs(
      this.platform,
      subtractMs(now, settings.stuckProcessingMs),
    );

    const dueJobs = await this.jobRepository.findDueJobs(
      this.platform,
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
          `Display name preload failed, continuing with lazy fallback: ${errorMessage(error)}`,
        );
      }
    }

    let claimed = 0;
    let sent = 0;
    let cancelled = 0;
    let retried = 0;
    let failed = 0;
    const failures: StudyReminderDispatchFailure[] = [];

    const CONCURRENCY_LIMIT = 3;
    const processJob = async (job: StudyReminderJob) => {
      const claimedJob = await this.jobRepository.claimJob(
        this.platform,
        job.id,
        settings.leaseMs,
      );
      if (!claimedJob) return;

      claimed += 1;
      const leaseToken = claimedJob.leaseToken ?? '';

      // Skip re-send if already delivered (#181) — crash between send and
      // markSent left a delivery_record; re-claim sees it and marks sent
      // without re-sending.
      if (claimedJob.deliveryRecord) {
        await this.jobRepository.markSent(claimedJob.id, leaseToken);
        this.hooks?.onSent?.({
          jobId: claimedJob.id,
          externalUserId: claimedJob.externalUserId,
        });
        sent += 1;
        return;
      }

      // Stuck processing was reset to ambiguous — provider may have accepted
      // the message, do not auto-resend (#294).
      if (claimedJob.deliveryStatus === 'ambiguous') {
        this.logger.warn(
          `Study reminder job re-claimed with ambiguous status jobId=${claimedJob.id} externalUserId=${maskExternalId(
            claimedJob.externalUserId,
          )} — skipping, ops review needed`,
        );
        return;
      }

      if (this.scheduleService.isSessionStarted(claimedJob.scheduledAt, now)) {
        await this.jobRepository.markCancelled(
          claimedJob.id,
          leaseToken,
          'session already started',
        );
        this.hooks?.onCancelled?.({
          jobId: claimedJob.id,
          externalUserId: claimedJob.externalUserId,
        });
        cancelled += 1;
        return;
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

        // Stable delivery key — persisted before calling the provider so that
        // a crash after send but before markSent leaves a recoverable record
        // (#294).
        const deliveryKey = `reminder:${claimedJob.id}:${claimedJob.sessionKey}`;

        await this.jobRepository.markDeliveryKey(claimedJob.id, deliveryKey);

        let outcome: OutboundDeliveryOutcome;
        let sendError: unknown;
        try {
          outcome = await this.messageSender.sendText({
            externalUserId: claimedJob.externalUserId,
            text,
            messageType: 'STUDY_REMINDER',
            userId: claimedJob.userId,
            deliveryKey,
          });
        } catch (error) {
          outcome = 'not_sent';
          sendError = error;
        }

        if (outcome === 'sent') {
          await this.jobRepository.markSent(
            claimedJob.id,
            leaseToken,
            'sent',
            deliveryKey,
          );
          this.hooks?.onSent?.({
            jobId: claimedJob.id,
            externalUserId: claimedJob.externalUserId,
          });
          sent += 1;
        } else if (outcome === 'ambiguous') {
          // Messenger/Zalo: provider may have accepted — no auto-resend (#294).
          await this.jobRepository.markFailed({
            jobId: claimedJob.id,
            leaseToken,
            errorMessage: 'ambiguous delivery — not auto-retried',
            retryCount: claimedJob.retryCount + 1,
            terminal: true,
          });
          this.hooks?.onFailed?.({
            jobId: claimedJob.id,
            externalUserId: claimedJob.externalUserId,
            error: 'ambiguous delivery — not auto-retried',
          });
          this.logger.warn(
            `Study reminder job ambiguous delivery jobId=${claimedJob.id} externalUserId=${maskExternalId(
              claimedJob.externalUserId,
            )} — terminal, not auto-retried`,
          );
          failed += 1;
        } else {
          // not_sent — throw so the outer catch block applies existing classification
          throw sendError ?? new Error('send failed');
        }
      } catch (error) {
        const errorMsg = this.toErrorMessage(error);

        const classification = this.options?.classifyFailure?.({
          error,
          job: claimedJob,
        });
        const terminal = classification
          ? classification.terminal
          : (this.hooks?.isTerminalError?.(error) ??
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
          leaseToken,
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
          this.hooks?.onFailed?.({
            jobId: claimedJob.id,
            externalUserId: claimedJob.externalUserId,
            error: errorMessage,
          });
          this.logger.warn(
            `Study reminder job failed terminal jobId=${claimedJob.id} externalUserId=${maskExternalId(
              claimedJob.externalUserId,
            )}: ${errorMessage}`,
          );
        } else {
          retried += 1;
          this.hooks?.onRetried?.({
            jobId: claimedJob.id,
            externalUserId: claimedJob.externalUserId,
            retryCount: nextRetryCount,
          });
          this.logger.warn(
            `Study reminder job retry jobId=${claimedJob.id} externalUserId=${maskExternalId(
              claimedJob.externalUserId,
            )} retry=${nextRetryCount}/${claimedJob.maxRetries}: ${errorMessage}`,
          );
        }
      }
    };

    // Process jobs with bounded concurrency (batches of CONCURRENCY_LIMIT)
    for (let i = 0; i < dueJobs.length; i += CONCURRENCY_LIMIT) {
      const batch = dueJobs.slice(i, i + CONCURRENCY_LIMIT);
      await Promise.allSettled(batch.map((job) => processJob(job)));
    }

    const nextDueAt = await this.jobRepository
      .findNextDueTime(now, this.platform)
      .catch((error) => {
        this.logger.warn(`findNextDueTime failed: ${errorMessage(error)}`);
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
    if (this.hooks?.generateReminder) {
      return this.hooks.generateReminder(
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
    return errorMessage(error);
  }
}
