import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  CanonicalPlatformService,
  WebActivityService,
} from '@wispace/database';
import { BotMetricsService } from '@wispace/bot-metrics';
import { errorMessage, maskExternalId } from '@wispace/bot-common/masking';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  PlatformStudentReportService,
  isStudentReportRetryableError,
} from '@wispace/student-report';
import { buildReportOptOutFooter } from '@wispace/bot-common/messages';
import type {
  ReportClaimRepositoryPort,
  ClassifiedError,
} from '@wispace/scheduler-core';
import {
  REPORT_CLAIM_REPOSITORY,
  ReportCronLeaderService,
  ReportCronLockService,
  ReportOrchestrationService,
  ReportScheduleService,
  evaluateExamWindow,
  runBatched,
  todayReportDate,
} from '@wispace/scheduler-core';
import { ZaloAccountLinkEntity } from '@zalo/infrastructure/database/entities/zalo-account-link.entity';
import { ZaloSendError } from '../../application/services/zalo-outbound.service';
import { WispaceApiError } from '@wispace/wispace-client';
import type { Platform } from '@wispace/contracts';
import {
  buildLlmExecutionConfig,
  resolveBackgroundProducerConcurrency,
} from '@wispace/llm-agent/adapters';
import { LlmOverloadError } from '@wispace/llm-agent/core';

const PAGE_SIZE = 200;
const MAX_REPORTED_ERRORS = 50;
const REPORT_CRON_EXPECTED_INTERVAL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class ZaloReportCronService {
  private readonly logger = new Logger(ZaloReportCronService.name);
  private readonly concurrency: number;

  constructor(
    @InjectRepository(ZaloAccountLinkEntity)
    private readonly linkRepo: Repository<ZaloAccountLinkEntity>,
    @Inject(REPORT_CLAIM_REPOSITORY)
    private readonly claimRepo: ReportClaimRepositoryPort,
    private readonly orchestration: ReportOrchestrationService,
    private readonly reportService: PlatformStudentReportService,
    private readonly reportScheduleService: ReportScheduleService,
    private readonly reportCronLeaderService: ReportCronLeaderService,
    private readonly reportCronLockService: ReportCronLockService,
    @Optional()
    @Inject(CanonicalPlatformService)
    private readonly canonicalPlatformService?: CanonicalPlatformService,
    @Optional()
    @Inject(WebActivityService)
    private readonly webActivityService?: WebActivityService,
    @Optional()
    @Inject(BotMetricsService)
    private readonly metrics?: BotMetricsService,
    @Optional() private readonly configService?: ConfigService,
  ) {
    const executionConfig = buildLlmExecutionConfig(
      this.configService
        ? (key) => this.configService?.get<string>(key)
        : undefined,
    );
    this.concurrency = resolveBackgroundProducerConcurrency(executionConfig, {
      enabled: executionConfig.enabled,
      producerName: 'zalo report',
      onWarning: (message) => this.logger.warn(message),
    });
    this.metrics?.registerCron?.(
      'zalo-report-cron',
      REPORT_CRON_EXPECTED_INTERVAL_MS,
    );
  }

  @Cron('0 8 * * *', {
    name: 'zalo-report-cron',
    timeZone: 'Asia/Ho_Chi_Minh',
  })
  async sendDailyReports(opts: { forceSend?: boolean } = {}): Promise<void> {
    // #510: platform-scoped coordination — Zalo elects its own leader and
    // holds its own advisory lock, so it can no longer lose a fleet-wide
    // race (it previously had none at all, and 2 pods could double-run).
    if (!(await this.reportCronLeaderService.shouldRunScheduledReportCron())) {
      return;
    }

    const acquired = await this.reportCronLockService.tryAcquireDailyLock();
    if (!acquired) return;

    const waveStartedAt = Date.now();
    try {
      await this.sendReportsBatch(opts);
      this.metrics?.observeReportWaveCompletionLag?.(
        (Date.now() - waveStartedAt) / 1000,
      );
      this.metrics?.recordCronSuccess?.('zalo-report-cron');
    } finally {
      await this.reportCronLockService.releaseDailyLock();
    }
  }

  async sendReportsBatch(opts: { forceSend?: boolean } = {}): Promise<void> {
    const reportDate = todayReportDate();
    const forceSend = opts.forceSend === true;

    const sentUserIds = new Set(
      await this.claimRepo.listUserIdsWithSentReportToday(reportDate),
    );

    this.logger.log(
      `Sending daily reports (reportDate=${reportDate}, forceSend=${forceSend})`,
    );

    let total = 0;
    let sent = 0;
    let skipped = 0;
    let failed = 0;
    const errors: string[] = [];
    let cursor: string | undefined;
    const startedAt = Date.now();
    let hasMore = true;

    while (hasMore) {
      let page = await this.loadPage(cursor, forceSend);
      if (page.length === 0) break;
      // Pagination advances by the raw page — filtering must not shorten it.
      const rawPageLen = page.length;
      const lastId = page[page.length - 1].id;

      // Skip web-dormant learners — never for an operator forceSend override.
      if (!forceSend && this.webActivityService) {
        const { active, suppressed } =
          await this.webActivityService.partitionDormant(page, (l) => l.userId);
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

      const results = await runBatched(page, this.concurrency, (link) =>
        this.sendReportForUser(
          link,
          reportDate,
          sentUserIds,
          forceSend,
          canonicalPlatforms,
        ),
      );
      for (const r of results) {
        if (r.status === 'fulfilled') {
          const v = r.value as 'sent' | 'skipped' | 'error';
          if (v === 'sent') sent++;
          else if (v === 'skipped') skipped++;
          else failed++;
        } else {
          failed++;
          this.pushError(errors, errorMessage(r.reason));
        }
      }

      this.logger.log(
        `Zalo report batch: total=${total} sent=${sent} skipped=${skipped} failed=${failed}`,
      );
      cursor = lastId;
      hasMore = rawPageLen === PAGE_SIZE;
    }

    this.logger.log(
      `Daily report done: total=${total} sent=${sent}, skipped(already-sent/claimed/48h/window)=${skipped}, failed=${failed}${errors.length > 0 ? ', errors=' + errors.join('; ') : ''} (${Date.now() - startedAt}ms)`,
    );
  }

  private async loadPage(
    cursor: string | undefined,
    includeUnsubscribed: boolean,
  ): Promise<ZaloAccountLinkEntity[]> {
    const qb = this.linkRepo
      .createQueryBuilder('link')
      .leftJoin(
        'user_notification_preferences',
        'pref',
        'pref.user_id = link.user_id',
      )
      .select([
        'link.id',
        'link.externalUserId',
        'link.userId',
        'link.platform',
        'link.linkState',
        'link.optoutNoticeSentAt',
      ])
      .where('link.platform = :platform', { platform: 'zalo' })
      .andWhere("COALESCE(link.link_state, 'active') = 'active'")
      .andWhere(cursor !== undefined ? 'link.id > :cursor' : 'TRUE', { cursor })
      .orderBy('link.id', 'ASC')
      .take(PAGE_SIZE);
    if (!includeUnsubscribed) {
      // Reports are opt-in (#596): NULL consent row = not opted in.
      // forceSend (ops override) skips this gate.
      qb.andWhere('COALESCE(pref.report_enabled, false) = true');
    }
    return qb.getMany();
  }

  private pushError(errors: string[], error: string): void {
    if (errors.length < MAX_REPORTED_ERRORS) {
      errors.push(error);
    } else if (errors.length === MAX_REPORTED_ERRORS) {
      errors.push('… additional errors omitted (see logs)');
    }
  }

  private async sendReportForUser(
    link: ZaloAccountLinkEntity,
    reportDate: string,
    sentUserIds: Set<number>,
    forceSend: boolean,
    canonicalPlatforms?: ReadonlyMap<number, Platform | undefined>,
  ): Promise<'sent' | 'skipped' | 'error'> {
    if (!forceSend && (link.userId === undefined || link.userId === null)) {
      this.logger.log(
        `Skip Zalo user ${maskExternalId(link.externalUserId)}: scheduled report requires a linked WISPACE userId`,
      );
      return 'skipped';
    }

    if (link.userId && canonicalPlatforms) {
      const canonicalPlatform = canonicalPlatforms.get(link.userId);
      if (canonicalPlatform && canonicalPlatform !== 'zalo') {
        this.logger.log(
          `Skip Zalo user ${maskExternalId(
            link.externalUserId,
          )}: canonical platform is ${canonicalPlatform} for userId=${maskExternalId(
            link.userId,
          )}`,
        );
        return 'skipped';
      }
    }

    if (link.linkState && link.linkState !== 'active') {
      return 'skipped';
    }

    if (!forceSend) {
      const window = await evaluateExamWindow(
        link.externalUserId,
        this.reportScheduleService,
        false,
      );
      if (window.skip) {
        this.logger.log(
          `Skip Zalo user ${maskExternalId(
            link.externalUserId,
          )}: outside exam window or schedule unavailable`,
        );
        return 'skipped';
      }
    }

    if (link.userId && sentUserIds.has(link.userId)) {
      this.logger.log(
        `Report already sent on another platform for userId=${maskExternalId(
          link.userId,
        )}, skipping Zalo`,
      );
      return 'skipped';
    }

    try {
      const mapping = {
        id: link.id,
        platform: 'zalo',
        externalUserId: link.externalUserId,
        userId: link.userId ?? undefined,
        notificationCadence: 'daily',
        status: 'ACTIVE',
      };

      // One-time opt-out footer for consent rows we can't distinguish from
      // explicitly opted-in learners (#596 Q10).
      const pendingNotice = link.optoutNoticeSentAt == null;
      const result = await this.orchestration.claimAndSend(mapping, {
        reportDate,
        // forceSend bypasses the window/consent gates, not daily dedupe.
        skipAlreadySentToday: true,
        allowUserIdLess: forceSend,
        reportText: '',
        classifyError: (error) => classifyZaloError(error, link.externalUserId),
        generateReport: async () => {
          const report = await this.reportService.generateReport(
            link.externalUserId,
          );
          return pendingNotice ? report + buildReportOptOutFooter() : report;
        },
      });

      if (result.sent > 0) {
        if (pendingNotice) {
          await this.linkRepo
            .update({ id: link.id }, { optoutNoticeSentAt: new Date() })
            .catch(() => undefined);
        }
        return 'sent';
      }
      if (result.skipped > 0 || result.claimSkipped > 0) return 'skipped';
      return 'error';
    } catch (error) {
      this.logger.error(
        `Failed to send report to Zalo user ${maskExternalId(
          link.externalUserId,
        )}: ${errorMessage(error, link.externalUserId)}`,
      );
      return 'error';
    }
  }
}

function classifyZaloError(
  error: unknown,
  externalUserId?: string,
): ClassifiedError {
  if (error instanceof ZaloSendError && error.is48hWindowError()) {
    return { kind: 'window_closed', message: '48h window closed' };
  }

  if (
    error instanceof WispaceApiError &&
    (error.statusCode === 401 || error.statusCode === 403)
  ) {
    return { kind: 'skipped', message: 'Wispace access denied' };
  }

  if (isStudentReportRetryableError(error)) {
    return {
      kind: 'retryable',
      message: 'Report generation temporarily unavailable',
      ...(error instanceof LlmOverloadError &&
      error.reason !== 'redis_unavailable'
        ? { retryCause: 'capacity_overload' as const }
        : {}),
    };
  }

  return { kind: 'failure', message: errorMessage(error, externalUserId) };
}
