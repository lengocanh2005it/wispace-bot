import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { errorMessage, maskExternalId } from '@wispace/bot-common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WispaceApiError } from '@wispace/wispace-client';
import { PlatformStudentReportService } from '@wispace/student-report';
import { readReportClaimLeaseMs } from '@wispace/database';
import type { ReportClaimRepositoryPort } from '@wispace/scheduler-core';
import {
  REPORT_CLAIM_REPOSITORY,
  ReportScheduleService,
  evaluateExamWindow,
  runBatched,
  todayReportDate,
} from '@wispace/scheduler-core';
import { ZaloAccountLinkEntity } from '@zalo/infrastructure/database/entities/zalo-account-link.entity';
import {
  ZaloOutboundService,
  ZaloSendError,
} from '../../application/services/zalo-outbound.service';

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
    private readonly outbound: ZaloOutboundService,
    private readonly reportService: PlatformStudentReportService,
    private readonly reportScheduleService: ReportScheduleService,
    private readonly configService: ConfigService,
  ) {}

  @Cron('0 8 * * *', {
    name: 'zalo-report-cron',
    timeZone: 'Asia/Ho_Chi_Minh',
  })
  async sendDailyReports(opts: { forceSend?: boolean } = {}): Promise<void> {
    const reportDate = todayReportDate();
    const forceSend = opts.forceSend === true;

    // Pre-query userIds that already got a report on another platform today —
    // avoids one SELECT per linked user inside the batched loop.
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
      const page = await this.loadPage(cursor);
      if (page.length === 0) break;
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
      cursor = page[page.length - 1].id;
      hasMore = page.length === PAGE_SIZE;
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
      ])
      .where('link.platform = :platform', { platform: 'zalo' })
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
    // Window gate: only auto-send inside the days-before-exam window
    // (same as Messenger/Discord). forceSend bypasses the window.
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

    let claimLeaseToken = '';
    let claimDeliveryRecord: string | undefined;
    if (link.userId) {
      if (sentUserIds.has(link.userId)) {
        this.logger.log(
          `Report already sent on another platform for userId=${maskExternalId(
            link.userId,
          )}, skipping Zalo`,
        );
        return 'skipped';
      }
      const claimed: {
        claimed: boolean;
        leaseToken?: string;
        deliveryRecord?: string;
      } = await this.claimRepo.tryClaimScheduledReport(
        {
          externalUserId: link.externalUserId,
          userId: link.userId,
          reportDate,
        },
        readReportClaimLeaseMs(this.configService),
      );
      if (!claimed.claimed || !claimed.leaseToken) {
        this.logger.log(
          `Report already claimed by another instance for Zalo user ${maskExternalId(
            link.externalUserId,
          )}, skipping`,
        );
        return 'skipped';
      }
      claimLeaseToken = claimed.leaseToken;
      claimDeliveryRecord =
        typeof claimed.deliveryRecord === 'string'
          ? claimed.deliveryRecord
          : undefined;
    }

    // Skip re-send if already delivered (#181) — crash between send and
    // markSent left a delivery_record; re-claim sees it and marks sent
    // without re-sending.
    if (claimDeliveryRecord) {
      await this.claimRepo.markScheduledReportClaimSent(
        { externalUserId: link.externalUserId, reportDate },
        claimLeaseToken,
      );
      return 'sent';
    }

    try {
      const report = await this.reportService.generateReport(
        link.externalUserId,
      );
      await this.outbound.sendText(link.externalUserId, report);
      if (link.userId) {
        await this.claimRepo.markScheduledReportClaimSent(
          {
            externalUserId: link.externalUserId,
            reportDate,
          },
          claimLeaseToken,
          'sent',
        );
      }
      this.logger.log(
        `Report sent to Zalo user ${maskExternalId(link.externalUserId)}`,
      );
      return 'sent';
    } catch (error) {
      if (link.userId) {
        await this.claimRepo
          .releaseScheduledReportClaim(
            {
              externalUserId: link.externalUserId,
              reportDate,
            },
            claimLeaseToken,
          )
          .catch((releaseError) => {
            this.logger.error(
              `Failed to release report claim for Zalo user ${maskExternalId(
                link.externalUserId,
              )}: ${errorMessage(releaseError)}`,
            );
          });
      }
      if (error instanceof ZaloSendError && error.is48hWindowError()) {
        this.logger.warn(
          `48h window closed for Zalo user ${maskExternalId(
            link.externalUserId,
          )}, report not delivered`,
        );
        return 'skipped';
      }
      if (
        error instanceof WispaceApiError &&
        (error.statusCode === 401 || error.statusCode === 403)
      ) {
        this.logger.warn(
          `Wispace access denied for Zalo user ${maskExternalId(
            link.externalUserId,
          )}: ${error.message}`,
        );
        return 'skipped';
      }
      this.logger.error(
        `Failed to send report to Zalo user ${maskExternalId(
          link.externalUserId,
        )}: ${errorMessage(error)}`,
      );
      return 'error';
    }
  }
}
