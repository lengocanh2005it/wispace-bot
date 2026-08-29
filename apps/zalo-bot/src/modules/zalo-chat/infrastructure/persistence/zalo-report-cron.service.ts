import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  CanonicalPlatformService,
  WebActivityService,
} from '@wispace/database';
import { BotMetricsService } from '@wispace/bot-metrics';
import { ConfigService } from '@nestjs/config';
import { errorMessage, maskExternalId } from '@wispace/bot-common/masking';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PlatformStudentReportService } from '@wispace/student-report';
import type { ReportClaimRepositoryPort } from '@wispace/scheduler-core';
import {
  REPORT_CLAIM_REPOSITORY,
  ReportOrchestrationService,
  ReportScheduleService,
  evaluateExamWindow,
  runBatched,
  todayReportDate,
} from '@wispace/scheduler-core';
import type { ClassifiedError } from '@wispace/scheduler-core';
import { ZaloAccountLinkEntity } from '@zalo/infrastructure/database/entities/zalo-account-link.entity';
import { ZaloSendError } from '../../application/services/zalo-outbound.service';
import { WispaceApiError } from '@wispace/wispace-client';

const CONCURRENCY = 3;
const PAGE_SIZE = 200;
const MAX_REPORTED_ERRORS = 50;

@Injectable()
export class ZaloReportCronService {
  private readonly logger = new Logger(ZaloReportCronService.name);

  constructor(
    @InjectRepository(ZaloAccountLinkEntity)
    private readonly linkRepo: Repository<ZaloAccountLinkEntity>,
    @Inject(REPORT_CLAIM_REPOSITORY)
    private readonly claimRepo: ReportClaimRepositoryPort,
    private readonly orchestration: ReportOrchestrationService,
    private readonly reportService: PlatformStudentReportService,
    private readonly reportScheduleService: ReportScheduleService,
    private readonly configService: ConfigService,
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
    name: 'zalo-report-cron',
    timeZone: 'Asia/Ho_Chi_Minh',
  })
  async sendDailyReports(opts: { forceSend?: boolean } = {}): Promise<void> {
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
      let page = await this.loadPage(cursor);
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

      const results = await runBatched(page, CONCURRENCY, (link) =>
        this.sendReportForUser(link, reportDate, sentUserIds, forceSend),
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
  ): Promise<ZaloAccountLinkEntity[]> {
    return this.linkRepo
      .createQueryBuilder('link')
      .select([
        'link.id',
        'link.externalUserId',
        'link.userId',
        'link.platform',
        'link.linkState',
      ])
      .where('link.platform = :platform', { platform: 'zalo' })
      .andWhere("COALESCE(link.link_state, 'active') = 'active'")
      .andWhere(cursor !== undefined ? 'link.id > :cursor' : 'TRUE', { cursor })
      .orderBy('link.id', 'ASC')
      .take(PAGE_SIZE)
      .getMany();
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
  ): Promise<'sent' | 'skipped' | 'error'> {
    if (link.userId && this.canonicalPlatformService) {
      const { isCanonical, canonicalPlatform } =
        await this.canonicalPlatformService.isCanonicalForUser(
          link.userId,
          'zalo',
        );
      if (!isCanonical) {
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

      const result = await this.orchestration.claimAndSend(mapping, {
        reportDate,
        skipAlreadySentToday: link.userId !== undefined,
        reportText: '',
        classifyError: classifyZaloError,
        generateReport: async () =>
          this.reportService.generateReport(link.externalUserId),
      });

      if (result.sent > 0) return 'sent';
      if (result.skipped > 0 || result.claimSkipped > 0) return 'skipped';
      return 'error';
    } catch (error) {
      this.logger.error(
        `Failed to send report to Zalo user ${maskExternalId(
          link.externalUserId,
        )}: ${errorMessage(error)}`,
      );
      return 'error';
    }
  }
}

function classifyZaloError(error: unknown): ClassifiedError {
  if (error instanceof ZaloSendError && error.is48hWindowError()) {
    return { kind: 'window_closed', message: '48h window closed' };
  }

  if (
    error instanceof WispaceApiError &&
    (error.statusCode === 401 || error.statusCode === 403)
  ) {
    return { kind: 'skipped', message: 'Wispace access denied' };
  }

  return { kind: 'failure', message: errorMessage(error) };
}
