import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import {
  ReportCronLeaderService,
  ReportCronLockService,
  ReportScheduleService,
  evaluateExamWindow,
  todayReportDate,
  runBatched,
} from '@wispace/scheduler-core';
import { Inject, Optional } from '@nestjs/common';
import {
  CanonicalPlatformService,
  WebActivityService,
} from '@wispace/database';
import { BotMetricsService } from '@wispace/bot-metrics';
import { maskExternalId } from '@wispace/bot-common/masking';
import { DiscordReportOrchestrationService } from './discord-report-orchestration.service';
import {
  DISCORD_REPORT_ACCOUNT_READER,
  type DiscordReportAccountPageReaderPort,
} from '../../domain/ports/discord-report-account-reader.port';
import type {
  ReportMapping,
  ClaimAndSendResult,
} from '@wispace/scheduler-core';

const PLATFORM = 'discord' as const;
const DEFAULT_SEND_CONCURRENCY = 3;
const PAGE_SIZE = 200;
const MAX_REPORTED_FAILURES = 50;

const ZERO: ClaimAndSendResult = {
  sent: 0,
  skipped: 0,
  deferred: 0,
  windowClosed: 0,
  claimSkipped: 0,
  retryQueued: 0,
  failures: [],
};

@Injectable()
export class DiscordReportCronService {
  private readonly logger = new Logger(DiscordReportCronService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly reportCronLeaderService: ReportCronLeaderService,
    private readonly reportCronLockService: ReportCronLockService,
    private readonly reportScheduleService: ReportScheduleService,
    private readonly orchestrationService: DiscordReportOrchestrationService,
    @Inject(DISCORD_REPORT_ACCOUNT_READER)
    private readonly accountReader: DiscordReportAccountPageReaderPort,
    @Optional()
    @Inject(CanonicalPlatformService)
    private readonly canonicalPlatformService?: CanonicalPlatformService,
    @Optional()
    @Inject(WebActivityService)
    private readonly webActivityService?: WebActivityService,
    @Optional()
    @Inject(BotMetricsService)
    private readonly metrics?: BotMetricsService,
  ) {}

  @Cron('0 8 * * *', {
    name: 'discord-exam-reminder-report',
    timeZone: 'Asia/Ho_Chi_Minh',
  })
  async handleDailyReportCron(): Promise<void> {
    if (!(await this.reportCronLeaderService.shouldRunScheduledReportCron())) {
      return;
    }

    const acquired = await this.reportCronLockService.tryAcquireDailyLock();
    if (!acquired) return;

    try {
      await this.sendScheduledReports();
    } finally {
      await this.reportCronLockService.releaseDailyLock();
    }
  }

  async sendScheduledReports(
    opts: { forceSend?: boolean; externalUserId?: string } = {},
  ) {
    const reportDate = todayReportDate();
    const concurrency = Number(
      this.configService.get<string>('DISCORD_REPORT_SEND_CONCURRENCY') ??
        DEFAULT_SEND_CONCURRENCY,
    );

    let total = 0;
    let sent = 0;
    let skipped = 0;
    let claimSkipped = 0;
    let failed = 0;
    const failures: Array<{ externalUserId: string; error: string }> = [];
    let cursor: string | undefined;
    const startedAt = Date.now();
    let hasMore = true;

    while (hasMore) {
      let page = await this.loadPage(cursor, opts.forceSend === true);
      if (page.length === 0) break;
      // Pagination advances by the raw page — filtering must not shorten it.
      const rawPageLen = page.length;
      const lastId = page[page.length - 1].id;

      // Skip web-dormant learners — never for an operator forceSend override.
      if (opts.forceSend !== true && this.webActivityService) {
        const { active, suppressed } =
          await this.webActivityService.partitionDormant(page, (l) => l.userId);
        page = active;
        if (suppressed > 0) {
          this.metrics?.incScheduledSendSuppressed('report', suppressed);
          skipped += suppressed;
        }
      }

      total += page.length;

      const results = await runBatched(
        page,
        concurrency,
        async (link): Promise<ClaimAndSendResult> => {
          const mapping: ReportMapping = {
            id: link.id,
            platform: PLATFORM,
            externalUserId: link.externalUserId,
            userId: link.userId ?? undefined,
            notificationCadence: 'daily',
            status: 'ACTIVE',
          };

          // One-time opt-out footer for consent rows we can't distinguish
          // from explicitly opted-in learners (#596 Q10).
          const pendingNotice = link.optoutNoticeSentAt == null;
          const result = await this.sendForLink(mapping, {
            reportDate: reportDate,
            forceSend: opts.forceSend === true,
            appendOptOutFooter: pendingNotice,
          });
          if (pendingNotice && result.sent > 0) {
            await this.accountReader
              .markOptOutNoticeSent?.(link.id)
              .catch(() => undefined);
          }
          return result;
        },
      );

      for (const result of results) {
        if (result.status === 'fulfilled') {
          const v = result.value as ClaimAndSendResult;
          sent += v.sent;
          skipped += v.skipped;
          claimSkipped += v.claimSkipped;
          for (const failure of v.failures) {
            failed += 1;
            this.pushFailure(failures, failure);
          }
        } else {
          failed += 1;
          this.pushFailure(failures, {
            externalUserId: 'unknown',
            error:
              (result.reason as Error | undefined)?.message ??
              String(result.reason),
          });
        }
      }

      this.logger.log(
        `Discord report batch: total=${total} sent=${sent} skipped=${skipped} claimSkipped=${claimSkipped} failed=${failed}`,
      );
      cursor = lastId;
      hasMore = rawPageLen === PAGE_SIZE;
    }

    this.logger.log(
      `Discord report cron: total=${total} sent=${sent} skipped=${skipped} claimSkipped=${claimSkipped} failed=${failed} (${Date.now() - startedAt}ms)`,
    );

    return {
      total,
      sent,
      skipped,
      claimSkipped,
      failed,
      failures,
    };
  }

  private async sendForLink(
    mapping: ReportMapping,
    opts: {
      reportDate: string;
      forceSend: boolean;
      appendOptOutFooter: boolean;
    },
  ): Promise<ClaimAndSendResult> {
    // Window gate: only auto-send inside the days-before-exam window
    // (same as Messenger). forceSend bypasses the window but still
    // respects already-sent-today unless the caller clears it.
    if (mapping.userId && this.canonicalPlatformService) {
      const { isCanonical, canonicalPlatform } =
        await this.canonicalPlatformService.isCanonicalForUser(
          mapping.userId,
          PLATFORM,
        );
      if (!isCanonical) {
        this.logger.log(
          `Skip Discord user ${maskExternalId(
            mapping.externalUserId,
          )}: canonical platform is ${canonicalPlatform} for userId=${maskExternalId(
            mapping.userId,
          )}`,
        );
        return { ...ZERO, skipped: 1 };
      }
    }

    const window = await evaluateExamWindow(
      mapping.externalUserId,
      this.reportScheduleService,
      opts.forceSend,
    );
    if (window.skip) {
      this.logger.log(
        `Skip Discord user ${maskExternalId(
          mapping.externalUserId,
        )}: outside exam window or schedule unavailable`,
      );
      return { ...ZERO, skipped: 1 };
    }

    return this.orchestrationService.claimAndSend(mapping, {
      reportDate: opts.reportDate,
      skipAlreadySentToday: !opts.forceSend,
      examDateForOutbox: window.examDate,
      appendOptOutFooter: opts.appendOptOutFooter,
    });
  }

  private async loadPage(
    cursor: string | undefined,
    includeUnsubscribed: boolean,
  ): Promise<
    Array<{
      id: string;
      externalUserId: string;
      userId: number | null;
      optoutNoticeSentAt?: Date | null;
    }>
  > {
    return this.accountReader.findActiveAccountsPage(cursor, PAGE_SIZE, {
      includeUnsubscribed,
    });
  }

  private pushFailure(
    failures: Array<{ externalUserId: string; error: string }>,
    failure: { externalUserId: string; error: string },
  ): void {
    if (failures.length < MAX_REPORTED_FAILURES) {
      failures.push(failure);
    } else if (failures.length === MAX_REPORTED_FAILURES) {
      failures.push({
        externalUserId: '…',
        error: 'additional failures omitted (see logs)',
      });
    }
  }
}
