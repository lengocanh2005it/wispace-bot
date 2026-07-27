import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  REPORT_SEND_JOB_REPOSITORY,
  type ReportSendJobRepositoryPort,
  ReportCronLeaderService,
  ReportScheduleService,
  ReportSendScheduleService,
  todayReportDate,
} from '@wispace/scheduler-core';
import {
  MESSENGER_REPOSITORY,
  type MessengerRepositoryPort,
} from '../../../messenger/domain/repositories/messenger.repository.port';
import { ReportSendOrchestrationService } from './report-send-orchestration.service';
import { PgAdvisoryLockService } from '../../../../shared/common/pg-advisory-lock.service';
import { ADVISORY_LOCK } from '../../../../shared/common/advisory-lock-ids';

@Injectable()
export class ReportSendRetryDispatchService {
  private readonly logger = new Logger(ReportSendRetryDispatchService.name);

  constructor(
    @Inject(REPORT_SEND_JOB_REPOSITORY)
    private readonly reportSendJobRepository: ReportSendJobRepositoryPort,
    @Inject(MESSENGER_REPOSITORY)
    private readonly messengerRepository: MessengerRepositoryPort,
    private readonly reportScheduleService: ReportScheduleService,
    private readonly reportSendScheduleService: ReportSendScheduleService,
    private readonly reportCronLeaderService: ReportCronLeaderService,
    private readonly reportSendOrchestrationService: ReportSendOrchestrationService,
    private readonly pgLock: PgAdvisoryLockService,
  ) {}

  /** R5: poll outbox — default 15 phút (khớp REPORT_SEND_RETRY_POLL_MINUTES). */
  @Cron('*/15 * * * *', {
    name: 'report-send-retry',
    timeZone: 'Asia/Ho_Chi_Minh',
  })
  async handleReportSendRetryCron(): Promise<void> {
    if (!this.reportCronLeaderService.shouldRunScheduledReportCron()) {
      return;
    }

    await this.pgLock.withLock(ADVISORY_LOCK.REPORT_SEND_RETRY_DISPATCH, () =>
      this.dispatchDueReportRetries(),
    );
  }

  async dispatchDueReportRetries(): Promise<{
    claimed: number;
    sent: number;
    retried: number;
    expired: number;
    windowClosed: number;
    failed: number;
    resetStuck: number;
    failures: Array<{ jobId: number; psid: string; error: string }>;
  }> {
    const settings = this.reportSendScheduleService.getOutboxSettings();
    const now = new Date();
    const reportDate = todayReportDate(settings.timezone, now);

    const resetStuck =
      await this.reportSendJobRepository.resetStuckProcessingJobs(
        new Date(now.getTime() - 10 * 60 * 1000),
      );

    const dueJobs = await this.reportSendJobRepository.findDueJobs(now);
    let claimed = 0;
    let sent = 0;
    let retried = 0;
    let expired = 0;
    let windowClosed = 0;
    let failed = 0;
    const failures: Array<{ jobId: number; psid: string; error: string }> = [];

    for (const job of dueJobs) {
      const daysUntilExam = this.reportScheduleService.calculateDaysUntilExam(
        job.examDate,
        now,
      );

      if (daysUntilExam < 0) {
        await this.reportSendJobRepository.markFailed({
          jobId: job.id,
          errorMessage: 'Exam date passed without successful report (R5)',
          retryCount: job.maxRetries,
          terminal: true,
        });
        expired += 1;
        this.logger.warn(
          `Report send job expired jobId=${job.id} psid=${job.externalUserId} examDate=${job.examDate}`,
        );
        continue;
      }

      const claimedJob = await this.reportSendJobRepository.claimJob(job.id);
      if (!claimedJob) {
        continue;
      }

      claimed += 1;

      const mapping = await this.messengerRepository.findActiveMappingByPsid(
        claimedJob.externalUserId,
      );

      if (!mapping?.psid) {
        await this.reportSendJobRepository.markFailed({
          jobId: claimedJob.id,
          errorMessage: 'Active mapping not found',
          retryCount: claimedJob.maxRetries,
          terminal: true,
        });
        failed += 1;
        continue;
      }

      const orchestrationResult =
        await this.reportSendOrchestrationService.claimAndSend(mapping, {
          reportDate,
          skipAlreadySentToday: true,
          examDateForOutbox: claimedJob.examDate,
        });

      if (orchestrationResult.sent > 0) {
        await this.reportSendJobRepository.markSent(claimedJob.id);
        sent += 1;
      } else if (orchestrationResult.skipped > 0) {
        await this.reportSendJobRepository.markSent(claimedJob.id);
        sent += 1;
      } else if (orchestrationResult.claimSkipped > 0) {
        const nextRetryAt = new Date(
          now.getTime() + settings.retryBackoffMinutes * 60 * 1000,
        );
        await this.reportSendJobRepository.markFailed({
          jobId: claimedJob.id,
          errorMessage: 'Report claim exists for today (R4)',
          retryCount: claimedJob.retryCount,
          nextRetryAt,
          terminal: false,
        });
        retried += 1;
      } else if (orchestrationResult.deferred > 0) {
        const nextRetryCount = claimedJob.retryCount + 1;
        const terminal = nextRetryCount >= claimedJob.maxRetries;
        const nextRetryAt = new Date(
          now.getTime() + settings.retryBackoffMinutes * 60 * 1000,
        );

        await this.reportSendJobRepository.markFailed({
          jobId: claimedJob.id,
          errorMessage: 'Wispace API retryable (R3/R5)',
          retryCount: nextRetryCount,
          nextRetryAt: terminal ? undefined : nextRetryAt,
          terminal,
        });

        if (terminal) {
          failed += 1;
          failures.push({
            jobId: claimedJob.id,
            psid: claimedJob.externalUserId,
            error: 'Wispace API retryable (R3/R5)',
          });
        } else {
          retried += 1;
        }

        this.logger.warn(
          `Report send retry Wispace 5xx jobId=${claimedJob.id} psid=${claimedJob.externalUserId} retry=${nextRetryCount}/${claimedJob.maxRetries}`,
        );
      } else if (orchestrationResult.windowClosed > 0) {
        await this.reportSendJobRepository.markFailed({
          jobId: claimedJob.id,
          errorMessage: 'Messenger 24h window closed',
          retryCount: claimedJob.maxRetries,
          terminal: true,
        });
        windowClosed += 1;
      } else if (orchestrationResult.failures.length > 0) {
        const error = orchestrationResult.failures[0].error;
        await this.reportSendJobRepository.markFailed({
          jobId: claimedJob.id,
          errorMessage: error,
          retryCount: claimedJob.maxRetries,
          terminal: true,
        });
        failed += 1;
        failures.push({
          jobId: claimedJob.id,
          psid: claimedJob.externalUserId,
          error,
        });
        this.logger.error(
          `Report send retry failed jobId=${claimedJob.id} psid=${claimedJob.externalUserId}`,
        );
      }
    }

    if (claimed > 0 || resetStuck > 0) {
      this.logger.log(
        `Report send retry dispatch: claimed=${claimed}, sent=${sent}, retried=${retried}, expired=${expired}, windowClosed=${windowClosed}, failed=${failed}, resetStuck=${resetStuck}`,
      );
    }

    return {
      claimed,
      sent,
      retried,
      expired,
      windowClosed,
      failed,
      resetStuck,
      failures,
    };
  }
}
