import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import {
  REPORT_SEND_JOB_REPOSITORY,
  ReportCronLeaderService,
  type ReportSendJobRepositoryPort,
  type ReportMapping,
  todayReportDate,
} from '@wispace/scheduler-core';
import { DiscordReportOrchestrationService } from './discord-report-orchestration.service';
import {
  DISCORD_REPORT_ACCOUNT_READER,
  type DiscordReportAccountPageReaderPort,
} from '../../domain/ports/discord-report-account-reader.port';
import { subMilliseconds, addMinutes } from 'date-fns';
import { BotMetricsService } from '@wispace/bot-metrics';
import { errorMessage, maskExternalId } from '@wispace/bot-common/masking';
import {
  PgAdvisoryLockService,
  ADVISORY_LOCKS,
} from '@wispace/bot-common/locks';
import { runLockedTick } from '@wispace/bot-common/cron';
import type { LockedTickItem } from '@wispace/bot-common/cron';
import { readEnvPositiveInt } from '@wispace/bot-common/config';

const PLATFORM = 'discord' as const;
const REPORT_RETRY_EXPECTED_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_LEASE_MS = 600_000;
const RETRY_BACKOFF_MINUTES = 15;
const DEFERRED_ERROR = 'Report generation deferred (upstream retryable)';

type ReportRetryItemDetail =
  | 'sent'
  | 'retried'
  | 'window_closed'
  | 'failed'
  | 'claim_skipped';

interface ReportRetryDispatchResult {
  sent: number;
  retryQueued: number;
  failed: number;
  windowClosed: number;
  failures: Array<{ externalUserId: string; error: string }>;
}

@Injectable()
export class DiscordReportRetryDispatchService {
  private readonly logger = new Logger(DiscordReportRetryDispatchService.name);

  constructor(
    private readonly configService: ConfigService,
    @Inject(REPORT_SEND_JOB_REPOSITORY)
    private readonly jobRepository: ReportSendJobRepositoryPort,
    private readonly orchestrationService: DiscordReportOrchestrationService,
    @Inject(DISCORD_REPORT_ACCOUNT_READER)
    private readonly accountLinkReader: DiscordReportAccountPageReaderPort,
    private readonly reportCronLeaderService: ReportCronLeaderService,
    private readonly pgLock: PgAdvisoryLockService,
    @Optional() private readonly metrics?: BotMetricsService,
  ) {
    this.metrics?.registerCron?.(
      'discord-report-retry-dispatch',
      REPORT_RETRY_EXPECTED_INTERVAL_MS,
    );
  }

  @Cron('*/15 * * * *', {
    name: 'discord-report-retry-dispatch',
    timeZone: 'Asia/Ho_Chi_Minh',
  })
  async handleRetryDispatch(): Promise<void> {
    if (!(await this.reportCronLeaderService.shouldRunScheduledReportCron())) {
      return;
    }

    await runLockedTick({
      name: 'discord-report-retry-dispatch',
      withLock: (run) =>
        this.pgLock.withLock(ADVISORY_LOCKS.DISCORD_REPORT_RETRY_DISPATCH, run),
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
    const now = new Date();
    // Invariant (#521): the stuck threshold must exceed the claim lease
    // (2x) so a slow send is never reclaimed while its owner still holds a
    // valid lease — the late markSent can then never hit a token mismatch.
    const resetStuck = await this.jobRepository.resetStuckProcessingJobs(
      subMilliseconds(now, 2 * this.leaseMs),
    );

    const dueJobs = await this.jobRepository.findDueJobs(now);
    let sent = 0;
    let retryQueued = 0;
    let failed = 0;
    let windowClosed = 0;
    const failures: Array<{ externalUserId: string; error: string }> = [];
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
        const claimed = await this.jobRepository.claimJob(job.id, this.leaseMs);
        if (!claimed) continue;

        const leaseToken = claimed.leaseToken ?? '';
        claimedJobId = claimed.id;
        claimedLeaseToken = leaseToken;
        claimedRetryCount = claimed.retryCount;
        claimedMaxRetries = claimed.maxRetries;

        const link = await this.accountLinkReader.findLinkStateByExternalUserId(
          job.externalUserId,
        );

        if (!link || (link.linkState && link.linkState !== 'active')) {
          if (link?.linkState === 'temporarily-unknown') {
            const nextRetryCount = job.retryCount + 1;
            await this.jobRepository.markFailed({
              jobId: job.id,
              leaseToken,
              errorMessage: 'WISPACE link status temporarily unknown',
              retryCount: nextRetryCount,
              nextRetryAt: addMinutes(new Date(), RETRY_BACKOFF_MINUTES),
              terminal: nextRetryCount >= job.maxRetries,
            });
            if (nextRetryCount < job.maxRetries) retryQueued += 1;
            else failed += 1;
            item = { outcome: 'succeeded', details: 'retried' };
            continue;
          }
          await this.jobRepository.markFailed({
            jobId: job.id,
            leaseToken,
            errorMessage: 'No active Discord account link',
            retryCount: job.retryCount + 1,
            terminal: true,
          });
          failed += 1;
          item = { outcome: 'succeeded', details: 'failed' };
          continue;
        }

        const mapping: ReportMapping = {
          id: link.id,
          platform: PLATFORM,
          externalUserId: job.externalUserId,
          userId: link.userId ?? undefined,
          notificationCadence: 'daily',
          status: 'ACTIVE',
        };

        const reportDate = todayReportDate();
        const result = await this.orchestrationService.claimAndSend(mapping, {
          reportDate,
          skipAlreadySentToday: true,
          examDateForOutbox: job.examDate,
        });

        if (result.sent > 0) {
          await this.jobRepository.markSent(job.id, leaseToken);
          sent += 1;
          item = { outcome: 'succeeded', details: 'sent' };
        } else if (result.skipped > 0) {
          // Report already delivered today by another path — outbox job is done.
          await this.jobRepository.markSent(job.id, leaseToken);
          sent += 1;
          item = { outcome: 'succeeded', details: 'sent' };
        } else if (result.claimSkipped > 0) {
          // Another worker holds a live claim for this learner's report —
          // requeue without consuming a retry; it will resolve on a later tick.
          await this.jobRepository.markFailed({
            jobId: job.id,
            leaseToken,
            errorMessage: 'Report claim exists for today',
            retryCount: job.retryCount,
            nextRetryAt: addMinutes(new Date(), RETRY_BACKOFF_MINUTES),
            terminal: false,
          });
          retryQueued += 1;
          item = { outcome: 'succeeded', details: 'retried' };
        } else if (result.deferred > 0) {
          // Upstream deferred (retryable generation/delivery) — park the job
          // with a future next_retry_at instead of leaving it processing.
          const nextRetryCount = job.retryCount + 1;
          const terminal = nextRetryCount >= job.maxRetries;
          await this.jobRepository.markFailed({
            jobId: job.id,
            leaseToken,
            errorMessage: DEFERRED_ERROR,
            retryCount: nextRetryCount,
            nextRetryAt: terminal
              ? undefined
              : addMinutes(new Date(), RETRY_BACKOFF_MINUTES),
            terminal,
          });
          if (terminal) {
            failed += 1;
            failures.push({
              externalUserId: job.externalUserId,
              error: DEFERRED_ERROR,
            });
          } else {
            retryQueued += 1;
          }
          item = {
            outcome: 'succeeded',
            details: terminal ? 'failed' : 'retried',
          };
        } else if (result.windowClosed > 0) {
          // Exam window closed — the report would be noise; expire the job.
          await this.jobRepository.markFailed({
            jobId: job.id,
            leaseToken,
            errorMessage: 'Exam window closed',
            retryCount: job.maxRetries,
            terminal: true,
          });
          windowClosed += 1;
          item = { outcome: 'succeeded', details: 'window_closed' };
        } else if (result.failures.length > 0) {
          const error = result.failures[0].error;
          const rateLimited = error === 'outbound_rate_limited';
          const nextRetryAt = rateLimited
            ? undefined
            : addMinutes(new Date(), 15);
          const nextRetryCount = job.retryCount + 1;
          await this.jobRepository.markFailed({
            jobId: job.id,
            leaseToken,
            errorMessage: error,
            retryCount: nextRetryCount,
            nextRetryAt,
            terminal: rateLimited || nextRetryCount >= job.maxRetries,
          });
          if (rateLimited || nextRetryCount >= job.maxRetries) {
            failed += 1;
            failures.push({ externalUserId: job.externalUserId, error });
          } else {
            retryQueued += 1;
          }
          item = {
            outcome: 'succeeded',
            details:
              rateLimited || nextRetryCount >= job.maxRetries
                ? 'failed'
                : 'retried',
          };
        }
      } catch (error) {
        const message = errorMessage(error, job.externalUserId);
        if (claimedJobId !== undefined && claimedLeaseToken) {
          const nextRetryCount = claimedRetryCount + 1;
          const terminal = nextRetryCount >= claimedMaxRetries;
          try {
            await this.jobRepository.markFailed({
              jobId: claimedJobId,
              leaseToken: claimedLeaseToken,
              errorMessage: message,
              retryCount: nextRetryCount,
              nextRetryAt: terminal
                ? undefined
                : addMinutes(new Date(), RETRY_BACKOFF_MINUTES),
              terminal,
            });
          } catch (transitionError) {
            this.logger.error(
              `Discord report retry state transition failed jobId=${claimedJobId}: ${errorMessage(transitionError, job.externalUserId)}`,
            );
          }
        }
        failed += 1;
        failures.push({ externalUserId: job.externalUserId, error: message });
        this.logger.error(
          `Discord report retry item failed externalUserId=${maskExternalId(
            job.externalUserId,
          )}: ${message}`,
        );
        item = { outcome: 'failed', details: 'failed' };
      } finally {
        items.push(item);
      }
    }

    if (dueJobs.length > 0 || resetStuck > 0) {
      this.logger.log(
        `Discord report retry dispatch: sent=${sent} retryQueued=${retryQueued} failed=${failed} windowClosed=${windowClosed} resetStuck=${resetStuck}`,
      );
    }

    return {
      result: { sent, retryQueued, failed, windowClosed, failures },
      items,
    };
  }

  private get leaseMs(): number {
    return readEnvPositiveInt(
      this.configService,
      'REPORT_SEND_LEASE_MS',
      DEFAULT_LEASE_MS,
    );
  }
}
