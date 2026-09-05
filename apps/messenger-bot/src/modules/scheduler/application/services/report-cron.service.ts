import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import {
  CanonicalPlatformService,
  WebActivityService,
} from '@wispace/database';
import { BotMetricsService } from '@wispace/bot-metrics';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { maskExternalId } from '@wispace/bot-common/masking';
import {
  ReportCronLeaderService,
  ReportCronLockService,
  ReportScheduleService,
  todayReportDate,
  runBatched,
  type SendScheduledReportsOptions,
  type SendScheduledReportsResult,
} from '@wispace/scheduler-core';
import { MESSENGER_REPOSITORY } from '@messenger/modules/messenger/domain/repositories/messenger.repository.port';
import type { MessengerMappingRepositoryPort } from '@messenger/modules/messenger/domain/repositories/messenger-mapping.repository.port';
import { ReportSendOrchestrationService } from './report-send-orchestration.service';
import type { UserMessengerMapping } from '@messenger/modules/messenger/domain/entities/messenger.types';
import type { ClaimAndSendResult } from '@wispace/scheduler-core';
import { readEnvPositiveInt } from '@messenger/shared/config/env-helpers';
import { ZERO } from './report-send-orchestration.service';

const REPORT_CRON_EXPECTED_INTERVAL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class ReportCronService {
  private readonly logger = new Logger(ReportCronService.name);

  constructor(
    @Inject(MESSENGER_REPOSITORY)
    private readonly messengerRepository: MessengerMappingRepositoryPort,
    private readonly reportScheduleService: ReportScheduleService,
    private readonly reportCronLeaderService: ReportCronLeaderService,
    private readonly reportCronLockService: ReportCronLockService,
    private readonly configService: ConfigService,
    private readonly reportSendOrchestrationService: ReportSendOrchestrationService,
    @Optional()
    @Inject(CanonicalPlatformService)
    private readonly canonicalPlatformService?: CanonicalPlatformService,
    @Optional()
    @Inject(WebActivityService)
    private readonly webActivityService?: WebActivityService,
    @Optional()
    @Inject(BotMetricsService)
    private readonly metrics?: BotMetricsService,
  ) {
    this.metrics?.registerCron?.(
      'weekly-cleanup-duplicate-mappings',
      7 * 24 * 60 * 60 * 1000,
    );
    this.metrics?.registerCron?.(
      'exam-reminder-report',
      REPORT_CRON_EXPECTED_INTERVAL_MS,
    );
  }

  @Cron('0 3 * * 1', {
    name: 'weekly-cleanup-duplicate-mappings',
    timeZone: 'Asia/Ho_Chi_Minh',
  })
  async handleWeeklyCleanup(): Promise<void> {
    this.logger.log('Weekly cleanup: deactivating duplicate mappings');
    const count =
      await this.messengerRepository.cleanupActiveDuplicateMappings();
    if (count > 0) {
      this.logger.log(
        `Weekly cleanup: deactivated ${count} duplicate mappings`,
      );
    }
    this.metrics?.recordCronSuccess?.('weekly-cleanup-duplicate-mappings');
  }

  @Cron('0 8 * * *', {
    name: 'exam-reminder-report',
    timeZone: 'Asia/Ho_Chi_Minh',
  })
  async handleExamReminderCron(): Promise<void> {
    if (!(await this.reportCronLeaderService.shouldRunScheduledReportCron())) {
      return;
    }

    const acquired = await this.reportCronLockService.tryAcquireDailyLock();
    if (!acquired) {
      return;
    }

    try {
      await this.sendScheduledReports();
      this.metrics?.recordCronSuccess?.('exam-reminder-report');
    } finally {
      await this.reportCronLockService.releaseDailyLock();
    }
  }

  async sendScheduledReports(
    options?: SendScheduledReportsOptions,
  ): Promise<SendScheduledReportsResult> {
    const forceSend = options?.forceSend === true;
    const allowDuplicate = options?.allowDuplicate === true;
    const skipAlreadySentToday = !allowDuplicate;
    const psidFilter = options?.externalUserId?.trim();

    const schedule = this.reportScheduleService.getExamReminderWindow();
    const reportDate = todayReportDate(
      this.configService.get<string>('CHAT_USAGE_TIMEZONE') ??
        'Asia/Ho_Chi_Minh',
    );

    if (forceSend) {
      const scope = psidFilter
        ? `psid=${maskExternalId(psidFilter)}`
        : 'all subscribed';
      this.logger.log(
        `Ops send-reports (${scope}): bypass exam window ${schedule.minDays}-${schedule.maxDays} days` +
          (allowDuplicate
            ? ', allowDuplicate=true'
            : ', skip already sent today'),
      );
    }

    const PAGE_SIZE = 500;
    const concurrency = this.readConcurrency();
    let totalMappings = 0;
    let sent = 0;
    let skipped = 0;
    let deferred = 0;
    let windowClosed = 0;
    let claimSkipped = 0;
    let retryQueued = 0;
    const failures: SendScheduledReportsResult['failures'] = [];

    // Keyset pagination: fetch mappings in bounded pages instead of loading
    // all at once — prevents unbounded memory growth as linked users scale.
    let cursor = 0;
    for (;;) {
      const page =
        await this.messengerRepository.findActiveSubscribedMappingsPage(
          cursor,
          PAGE_SIZE,
        );

      if (page.length === 0) break;

      // Update cursor to the last ID in this page for next iteration
      const lastId = page[page.length - 1]!.id;
      cursor = lastId;

      let mappings = page;
      if (psidFilter) {
        mappings = mappings.filter((m) => m.psid === psidFilter);
      }

      // Skip web-dormant learners — but never for an operator forceSend, which
      // is an explicit "send now" override (same posture as the exam-window gate).
      if (!forceSend && this.webActivityService) {
        const { active, suppressed } =
          await this.webActivityService.partitionDormant(
            mappings,
            (m) => m.userId,
          );
        mappings = active;
        if (suppressed > 0) {
          this.metrics?.incScheduledSendSuppressed('report', suppressed);
          skipped += suppressed;
        }
      }

      totalMappings += mappings.length;

      const settled = await runBatched(mappings, concurrency, (mapping) =>
        this.processMappingForReport(mapping, {
          forceSend,
          skipAlreadySentToday,
          reportDate,
        }),
      );

      for (const r of settled) {
        if (r.status === 'fulfilled') {
          sent += r.value.sent;
          skipped += r.value.skipped;
          deferred += r.value.deferred;
          windowClosed += r.value.windowClosed;
          claimSkipped += r.value.claimSkipped;
          retryQueued += r.value.retryQueued;
          failures.push(...r.value.failures);
        }
      }

      // If filtering by psid and we already found it, no need to scan remaining pages
      if (psidFilter && mappings.length > 0) break;

      // Partial page signals end of data
      if (page.length < PAGE_SIZE) break;
    }

    if (psidFilter && totalMappings === 0) {
      throw new BadRequestException(
        `No active subscribed mapping for psid=${maskExternalId(psidFilter)}`,
      );
    }

    return {
      total: totalMappings,
      sent,
      skipped,
      deferred,
      windowClosed,
      claimSkipped,
      retryQueued,
      failed: failures.length,
      schedule,
      failures,
    };
  }

  private async processMappingForReport(
    mapping: UserMessengerMapping,
    opts: {
      forceSend: boolean;
      skipAlreadySentToday: boolean;
      reportDate: string;
    },
  ): Promise<ClaimAndSendResult> {
    const { forceSend, skipAlreadySentToday, reportDate } = opts;

    if (!mapping.psid) {
      this.logger.log(`Skip mapping ${mapping.id}: missing PSID`);
      return { ...ZERO, skipped: 1 };
    }

    if (!forceSend && mapping.userId === undefined) {
      this.logger.log(
        `Skip Messenger PSID ${maskExternalId(mapping.psid)}: scheduled report requires a linked WISPACE userId`,
      );
      return { ...ZERO, skipped: 1 };
    }

    if (mapping.userId && this.canonicalPlatformService) {
      const { isCanonical, canonicalPlatform } =
        await this.canonicalPlatformService.isCanonicalForUser(
          mapping.userId,
          'messenger',
        );
      if (!isCanonical) {
        this.logger.log(
          `Skip Messenger PSID ${maskExternalId(
            mapping.psid,
          )}: canonical platform is ${canonicalPlatform} for userId=${maskExternalId(
            mapping.userId,
          )}`,
        );
        return { ...ZERO, skipped: 1 };
      }
    }

    // Single Wispace API call — supplies both shouldSend and examDate
    let examDateForOutbox: string | undefined;
    try {
      const userSchedule =
        await this.reportScheduleService.shouldSendReportToday(mapping.psid);
      examDateForOutbox = userSchedule.examDate;

      if (!forceSend && !userSchedule.shouldSend) {
        this.logger.log(
          `Skip PSID ${maskExternalId(mapping.psid)}: examDate=${
            userSchedule.examDate
          }, daysUntilExam=${userSchedule.daysUntilExam}, window=${
            userSchedule.minDays
          }-${userSchedule.maxDays}`,
        );
        return { ...ZERO, skipped: 1 };
      }
    } catch (err) {
      if (!forceSend) {
        this.logger.warn(
          `Skip PSID ${maskExternalId(
            mapping.psid,
          )}: could not resolve exam schedule`,
          err,
        );
        return { ...ZERO, skipped: 1 };
      }
      // forceSend: continue without examDate
    }

    return this.reportSendOrchestrationService.claimAndSend(mapping, {
      reportDate,
      skipAlreadySentToday,
      examDateForOutbox,
    });
  }

  private readConcurrency(): number {
    return readEnvPositiveInt(this.configService, 'REPORT_SEND_CONCURRENCY', 5);
  }
}
