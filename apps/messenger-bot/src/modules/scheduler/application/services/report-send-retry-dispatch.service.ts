import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  REPORT_SEND_JOB_REPOSITORY,
  type ReportSendJobRepositoryPort,
  ReportCronLeaderService,
  ReportScheduleService,
  ReportSendScheduleService,
  todayReportDate,
} from '@wispace/scheduler-core';
import { MESSENGER_REPOSITORY } from '@messenger/modules/messenger/domain/repositories/messenger.repository.port';
import type { MessengerMappingRepositoryPort } from '@messenger/modules/messenger/domain/repositories/messenger-mapping.repository.port';
import { ReportSendOrchestrationService } from './report-send-orchestration.service';
import { errorMessage, maskExternalId } from '@wispace/bot-common/masking';
import { PgAdvisoryLockService } from '@wispace/bot-common/locks';
import { runLockedTick } from '@wispace/bot-common/cron';
import type { LockedTickItem } from '@wispace/bot-common/cron';
import { subMilliseconds } from 'date-fns';
import { ADVISORY_LOCK } from '@messenger/shared/common/advisory-lock-ids';
import { reportRetryAt } from '../utils/report-retry-at';
import { BotMetricsService } from '@wispace/bot-metrics';

const REPORT_RETRY_EXPECTED_INTERVAL_MS = 15 * 60 * 1000;

type ReportRetryItemDetail =
  | 'sent'
  | 'retried'
  | 'expired'
  | 'window_closed'
  | 'failed'
  | 'claim_skipped';

export interface ReportRetryDispatchResult {
  claimed: number;
  sent: number;
  retried: number;
  expired: number;
  windowClosed: number;
  failed: number;
  resetStuck: number;
  failures: Array<{ jobId: number; psid: string; error: string }>;
}

@Injectable()
export class ReportSendRetryDispatchService {
  private readonly logger = new Logger(ReportSendRetryDispatchService.name);

  constructor(
    @Inject(REPORT_SEND_JOB_REPOSITORY)
    private readonly reportSendJobRepository: ReportSendJobRepositoryPort,
    @Inject(MESSENGER_REPOSITORY)
    private readonly messengerRepository: MessengerMappingRepositoryPort,
    private readonly reportScheduleService: ReportScheduleService,
    private readonly reportSendScheduleService: ReportSendScheduleService,
    private readonly reportCronLeaderService: ReportCronLeaderService,
    private readonly reportSendOrchestrationService: ReportSendOrchestrationService,
    private readonly pgLock: PgAdvisoryLockService,
    @Optional() private readonly metrics?: BotMetricsService,
  ) {
    this.metrics?.registerCron?.(
      'report-send-retry',
      REPORT_RETRY_EXPECTED_INTERVAL_MS,
    );
  }

  /** R5: poll outbox — default 15 phút (khớp REPORT_SEND_RETRY_POLL_MINUTES). */
  @Cron('*/15 * * * *', {
    name: 'report-send-retry',
    timeZone: 'Asia/Ho_Chi_Minh',
  })
  async handleReportSendRetryCron(): Promise<void> {
    if (!(await this.reportCronLeaderService.shouldRunScheduledReportCron())) {
      return;
    }

    await runLockedTick({
      name: 'report-send-retry',
      withLock: (run) =>
        this.pgLock.withLock(ADVISORY_LOCK.REPORT_SEND_RETRY_DISPATCH, run),
      run: async () => (await this.dispatchDueReportRetriesWithItems()).items,
      metrics: this.metrics,
      logger: this.logger,
    });
  }

  async dispatchDueReportRetries(): Promise<ReportRetryDispatchResult> {
    return (await this.dispatchDueReportRetriesWithItems()).result;
  }

  private async dispatchDueReportRetriesWithItems(): Promise<{
    result: ReportRetryDispatchResult;
    items: LockedTickItem<ReportRetryItemDetail>[];
  }> {
    const settings = this.reportSendScheduleService.getOutboxSettings();
    const now = new Date();
    const reportDate = todayReportDate(settings.timezone, now);

    const resetStuck =
      await this.reportSendJobRepository.resetStuckProcessingJobs(
        subMilliseconds(now, 10 * 60 * 1000),
      );

    const dueJobs = await this.reportSendJobRepository.findDueJobs(now);
    let claimed = 0;
    let sent = 0;
    let retried = 0;
    let expired = 0;
    let windowClosed = 0;
    let failed = 0;
    const failures: Array<{ jobId: number; psid: string; error: string }> = [];
    const items: LockedTickItem<ReportRetryItemDetail>[] = [];

    for (const job of dueJobs) {
      let item: LockedTickItem<ReportRetryItemDetail> = {
        outcome: 'skipped',
        details: 'claim_skipped',
      };
      let claimedJobId: number | undefined;
      let claimedLeaseToken: string | undefined;
      let claimedRetryCount = job.retryCount;
      let claimedMaxRetries = job.maxRetries;
      try {
        // The job's examDate is frozen at failure time — re-resolve it so an
        // exam reschedule is honored (a moved-up exam otherwise expires the job
        // even though the new exam is still upcoming, and a moved-back exam
        // keeps stale retries).
        const examDate = await this.resolveFreshExamDate(
          job.externalUserId,
          job.examDate,
        );
        const daysUntilExam = this.reportScheduleService.calculateDaysUntilExam(
          examDate,
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
            `Report send job expired jobId=${job.id} psid=${maskExternalId(
              job.externalUserId,
            )} examDate=${examDate}`,
          );
          item = { outcome: 'succeeded', details: 'expired' };
          continue;
        }

        const claimedJob = await this.reportSendJobRepository.claimJob(
          job.id,
          settings.leaseMs,
        );
        if (!claimedJob) {
          continue;
        }

        claimed += 1;
        const leaseToken = claimedJob.leaseToken ?? '';
        claimedJobId = claimedJob.id;
        claimedLeaseToken = leaseToken;
        claimedRetryCount = claimedJob.retryCount;
        claimedMaxRetries = claimedJob.maxRetries;

        const mapping = await this.messengerRepository.findActiveMappingByPsid(
          claimedJob.externalUserId,
        );

        if (!mapping?.psid) {
          const linkState =
            await this.messengerRepository.findMappingStateByPsid(
              claimedJob.externalUserId,
            );
          if (linkState === 'temporarily-unknown') {
            const nextRetryCount = claimedJob.retryCount + 1;
            await this.reportSendJobRepository.markFailed({
              jobId: claimedJob.id,
              leaseToken,
              errorMessage: 'WISPACE link status temporarily unknown',
              retryCount: nextRetryCount,
              nextRetryAt: reportRetryAt(settings.retryBackoffMinutes),
              terminal: nextRetryCount >= claimedJob.maxRetries,
            });
            if (nextRetryCount >= claimedJob.maxRetries) failed += 1;
            else retried += 1;
            item = { outcome: 'succeeded', details: 'retried' };
            continue;
          }
          await this.reportSendJobRepository.markFailed({
            jobId: claimedJob.id,
            leaseToken,
            errorMessage: 'Active mapping not found',
            retryCount: claimedJob.maxRetries,
            terminal: true,
          });
          failed += 1;
          item = { outcome: 'succeeded', details: 'failed' };
          continue;
        }

        const orchestrationResult =
          await this.reportSendOrchestrationService.claimAndSend(mapping, {
            reportDate,
            skipAlreadySentToday: true,
            examDateForOutbox: examDate,
            attempt: 'retry',
            ...(claimedJob.retryCause
              ? { retryCause: claimedJob.retryCause }
              : {}),
          });

        if (orchestrationResult.sent > 0) {
          await this.reportSendJobRepository.markSent(
            claimedJob.id,
            leaseToken,
          );
          sent += 1;
          item = { outcome: 'succeeded', details: 'sent' };
        } else if (orchestrationResult.skipped > 0) {
          await this.reportSendJobRepository.markSent(
            claimedJob.id,
            leaseToken,
          );
          sent += 1;
          item = { outcome: 'succeeded', details: 'sent' };
        } else if (orchestrationResult.claimSkipped > 0) {
          const nextRetryAt = reportRetryAt(settings.retryBackoffMinutes);
          await this.reportSendJobRepository.markFailed({
            jobId: claimedJob.id,
            leaseToken,
            errorMessage: 'Report claim exists for today (R4)',
            retryCount: claimedJob.retryCount,
            nextRetryAt,
            terminal: false,
          });
          retried += 1;
          item = { outcome: 'succeeded', details: 'retried' };
        } else if (orchestrationResult.deferred > 0) {
          const nextRetryCount = claimedJob.retryCount + 1;
          const terminal = nextRetryCount >= claimedJob.maxRetries;
          const nextRetryAt = reportRetryAt(settings.retryBackoffMinutes);

          await this.reportSendJobRepository.markFailed({
            jobId: claimedJob.id,
            leaseToken,
            errorMessage: 'Wispace API retryable (R3/R5)',
            retryCount: nextRetryCount,
            nextRetryAt: terminal ? undefined : nextRetryAt,
            terminal,
            retryCause: orchestrationResult.retryCause,
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
          item = {
            outcome: 'succeeded',
            details: terminal ? 'failed' : 'retried',
          };

          this.logger.warn(
            `Report send retry Wispace 5xx jobId=${claimedJob.id} psid=${maskExternalId(
              claimedJob.externalUserId,
            )} retry=${nextRetryCount}/${claimedJob.maxRetries}`,
          );
        } else if (orchestrationResult.windowClosed > 0) {
          await this.reportSendJobRepository.markFailed({
            jobId: claimedJob.id,
            leaseToken,
            errorMessage: 'Messenger 24h window closed',
            retryCount: claimedJob.maxRetries,
            terminal: true,
          });
          windowClosed += 1;
          item = { outcome: 'succeeded', details: 'window_closed' };
        } else if (orchestrationResult.failures.length > 0) {
          const error = orchestrationResult.failures[0].error;
          await this.reportSendJobRepository.markFailed({
            jobId: claimedJob.id,
            leaseToken,
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
            `Report send retry failed jobId=${claimedJob.id} psid=${maskExternalId(
              claimedJob.externalUserId,
            )}`,
          );
          item = { outcome: 'succeeded', details: 'failed' };
        }
      } catch (error) {
        const message = errorMessage(error, job.externalUserId);
        if (claimedJobId !== undefined && claimedLeaseToken) {
          const nextRetryCount = claimedRetryCount + 1;
          const terminal = nextRetryCount >= claimedMaxRetries;
          try {
            await this.reportSendJobRepository.markFailed({
              jobId: claimedJobId,
              leaseToken: claimedLeaseToken,
              errorMessage: message,
              retryCount: nextRetryCount,
              nextRetryAt: terminal
                ? undefined
                : reportRetryAt(settings.retryBackoffMinutes),
              terminal,
            });
          } catch (transitionError) {
            this.logger.error(
              `Report send retry state transition failed jobId=${claimedJobId}: ${errorMessage(transitionError, job.externalUserId)}`,
            );
          }
        }
        failed += 1;
        failures.push({
          jobId: job.id,
          psid: job.externalUserId,
          error: message,
        });
        this.logger.error(
          `Report send retry item failed jobId=${job.id} psid=${maskExternalId(
            job.externalUserId,
          )}: ${message}`,
        );
        item = { outcome: 'failed', details: 'failed' };
      } finally {
        items.push(item);
      }
    }

    if (claimed > 0 || resetStuck > 0) {
      this.logger.log(
        `Report send retry dispatch: claimed=${claimed}, sent=${sent}, retried=${retried}, expired=${expired}, windowClosed=${windowClosed}, failed=${failed}, resetStuck=${resetStuck}`,
      );
    }

    return {
      result: {
        claimed,
        sent,
        retried,
        expired,
        windowClosed,
        failed,
        resetStuck,
        failures,
      },
      items,
    };
  }

  /**
   * Latest exam date for the user (Wispace goals), falling back to the job's
   * frozen date when Wispace is unreachable — a rescheduled exam must not
   * expire or prolong the outbox based on stale data.
   */
  private async resolveFreshExamDate(
    psid: string,
    fallback: string,
  ): Promise<string> {
    try {
      const schedule =
        await this.reportScheduleService.shouldSendReportToday(psid);
      return schedule.examDate;
    } catch {
      return fallback;
    }
  }
}
