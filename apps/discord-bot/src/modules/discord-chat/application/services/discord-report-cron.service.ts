import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { evaluateExamWindow, runBatched } from '@wispace/scheduler-core/core';
import { todayInTimezone } from '@wispace/wispace-client/core';
import type {
  CanonicalPlatformPort,
  ReportCronLeaderPort,
  ReportCronLockPort,
  ReportSchedulePort,
  WebActivityPort,
  ReportMapping,
  ClaimAndSendResult,
} from '@wispace/scheduler-core/core';
import {
  CANONICAL_PLATFORM,
  REPORT_CRON_LEADER,
  REPORT_CRON_LOCK,
  REPORT_SCHEDULE,
  WEB_ACTIVITY,
} from '../../domain/ports/report-cron-seams.port';
import { BotMetricsService } from '@wispace/bot-metrics';
import { maskExternalId } from '@wispace/bot-common/masking';
import { readOptionalPositiveInt } from '@wispace/bot-common/config';
import { withRootSpan, BOT_SERVICE_NAMES } from '@wispace/bot-common/tracing';
import {
  fullPageAsMappingPage,
  iterateMappingPages,
} from '@wispace/bot-common/utils';
import {
  buildLlmExecutionConfig,
  resolveBackgroundProducerConcurrency,
} from '@wispace/llm-agent/core';
import { DISCORD_REPORT_PRODUCER } from '../../report-producer';
import { DiscordReportOrchestrationService } from './discord-report-orchestration.service';
import {
  DISCORD_REPORT_ACCOUNT_READER,
  type DiscordReportAccountPageReaderPort,
  type ReportAccountRow,
} from '../../domain/ports/discord-report-account-reader.port';
import type { Platform } from '@wispace/contracts';

const PLATFORM = 'discord' as const;
const PAGE_SIZE = 200;
const MAX_REPORTED_FAILURES = 50;
const REPORT_CRON_EXPECTED_INTERVAL_MS = 24 * 60 * 60 * 1000;

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
  private readonly concurrency: number;

  constructor(
    private readonly configService: ConfigService,
    @Inject(REPORT_CRON_LEADER)
    private readonly reportCronLeaderService: ReportCronLeaderPort,
    @Inject(REPORT_CRON_LOCK)
    private readonly reportCronLockService: ReportCronLockPort,
    @Inject(REPORT_SCHEDULE)
    private readonly reportScheduleService: ReportSchedulePort,
    private readonly orchestrationService: DiscordReportOrchestrationService,
    @Inject(DISCORD_REPORT_ACCOUNT_READER)
    private readonly accountReader: DiscordReportAccountPageReaderPort,
    @Optional()
    @Inject(CANONICAL_PLATFORM)
    private readonly canonicalPlatformService?: CanonicalPlatformPort,
    @Optional()
    @Inject(WEB_ACTIVITY)
    private readonly webActivityService?: WebActivityPort,
    @Optional()
    @Inject(BotMetricsService)
    private readonly metrics?: BotMetricsService,
  ) {
    const executionConfig = buildLlmExecutionConfig((key) =>
      this.configService.get<string>(key),
    );
    this.concurrency = resolveBackgroundProducerConcurrency(executionConfig, {
      enabled: executionConfig.enabled,
      producerName: DISCORD_REPORT_PRODUCER.producerName,
      configuredConcurrency: readOptionalPositiveInt(
        (key) => this.configService.get<string>(key),
        DISCORD_REPORT_PRODUCER.concurrencyEnvKey,
      ),
      onWarning: (message) => this.logger.warn(message),
    });
    this.metrics?.registerCron?.(
      'discord-exam-reminder-report',
      REPORT_CRON_EXPECTED_INTERVAL_MS,
    );
  }

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

    const waveStartedAt = Date.now();
    try {
      // A cron with no human watching the request. The wave's LLM report
      // generation and WISPACE calls are already instrumented by
      // BotMetricsService, but they need a parent to nest under (#1458).
      await withRootSpan(
        BOT_SERVICE_NAMES.discord,
        'discord.report_cron',
        {},
        () => this.sendScheduledReports(),
      );
      this.metrics?.observeReportWaveCompletionLag?.(
        (Date.now() - waveStartedAt) / 1000,
      );
      this.metrics?.recordCronSuccess?.('discord-exam-reminder-report');
    } finally {
      await this.reportCronLockService.releaseDailyLock();
    }
  }

  async sendScheduledReports(
    opts: { forceSend?: boolean; externalUserId?: string } = {},
  ) {
    const reportDate = todayInTimezone('Asia/Ho_Chi_Minh');
    const concurrency = this.concurrency;

    let total = 0;
    let sent = 0;
    let skipped = 0;
    let claimSkipped = 0;
    let failed = 0;
    const failures: Array<{ externalUserId: string; error: string }> = [];
    const startedAt = Date.now();

    // The scan ends when a page declares no continuation; see ADR-0049. The
    // page is sized before any dormancy filter runs, so a full page that the
    // filter empties still continues the scan.
    await iterateMappingPages<ReportAccountRow, string>({
      source: {
        fetch: async (cursor, limit) =>
          fullPageAsMappingPage(
            await this.loadPage(cursor, opts.forceSend === true, limit),
            limit,
          ),
      },
      limit: PAGE_SIZE,
      onPage: async (rawPage) => {
        let page = rawPage;

        // Skip web-dormant learners — never for an operator forceSend override.
        if (opts.forceSend !== true && this.webActivityService) {
          const { active, suppressed } =
            await this.webActivityService.partitionDormant(
              page,
              (l) => l.userId,
            );
          page = active;
          if (suppressed > 0) {
            this.metrics?.incScheduledSendSuppressed('report', suppressed);
            skipped += suppressed;
          }
        }

        total += page.length;
        const canonicalPlatforms = this.canonicalPlatformService
          ? await this.canonicalPlatformService.getCanonicalPlatformsForUsers([
              ...new Set(
                page.flatMap((link) =>
                  link.userId == null ? [] : [link.userId],
                ),
              ),
            ])
          : undefined;

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
              canonicalPlatforms,
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
      },
    });

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
      canonicalPlatforms?: ReadonlyMap<number, Platform | undefined>;
    },
  ): Promise<ClaimAndSendResult> {
    if (!opts.forceSend && mapping.userId === undefined) {
      this.logger.log(
        `Skip Discord user ${maskExternalId(mapping.externalUserId)}: scheduled report requires a linked WISPACE userId`,
      );
      return { ...ZERO, skipped: 1 };
    }

    // Window gate: only auto-send inside the days-before-exam window
    // (same as Messenger). forceSend bypasses the window but still
    // respects already-sent-today.
    if (mapping.userId && opts.canonicalPlatforms) {
      const canonicalPlatform = opts.canonicalPlatforms.get(mapping.userId);
      if (canonicalPlatform && canonicalPlatform !== PLATFORM) {
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
      // forceSend bypasses the window/consent gates, not daily dedupe.
      skipAlreadySentToday: true,
      allowUserIdLess: opts.forceSend,
      examDateForOutbox: window.examDate,
      appendOptOutFooter: opts.appendOptOutFooter,
    });
  }

  private async loadPage(
    cursor: string | undefined,
    includeUnsubscribed: boolean,
    limit: number,
  ): Promise<ReportAccountRow[]> {
    return this.accountReader.findActiveAccountsPage(cursor, limit, {
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
