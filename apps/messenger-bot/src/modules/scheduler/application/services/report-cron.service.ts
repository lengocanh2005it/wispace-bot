import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import {
  ReportCronLeaderService,
  ReportCronLockService,
  ReportScheduleService,
  todayReportDate,
  runBatched,
  type SendScheduledReportsOptions,
  type SendScheduledReportsResult,
} from '@wispace/scheduler-core';
import {
  MESSENGER_REPOSITORY,
  type MessengerRepositoryPort,
} from '@messenger/modules/messenger/domain/repositories/messenger.repository.port';
import { ReportSendOrchestrationService } from './report-send-orchestration.service';
import type { UserMessengerMapping } from '@messenger/modules/messenger/domain/entities/messenger.types';
import type { ClaimAndSendResult } from '@wispace/scheduler-core';
import { readEnvPositiveInt } from '@messenger/shared/config/env-helpers';
import { ZERO } from './report-send-orchestration.service';

@Injectable()
export class ReportCronService {
  private readonly logger = new Logger(ReportCronService.name);

  constructor(
    @Inject(MESSENGER_REPOSITORY)
    private readonly messengerRepository: MessengerRepositoryPort,
    private readonly reportScheduleService: ReportScheduleService,
    private readonly reportCronLeaderService: ReportCronLeaderService,
    private readonly reportCronLockService: ReportCronLockService,
    private readonly configService: ConfigService,
    private readonly reportSendOrchestrationService: ReportSendOrchestrationService,
  ) {}

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
  }

  @Cron('0 8 * * *', {
    name: 'exam-reminder-report',
    timeZone: 'Asia/Ho_Chi_Minh',
  })
  async handleExamReminderCron(): Promise<void> {
    if (!this.reportCronLeaderService.shouldRunScheduledReportCron()) {
      return;
    }

    const acquired = await this.reportCronLockService.tryAcquireDailyLock();
    if (!acquired) {
      return;
    }

    try {
      await this.sendScheduledReports();
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
      const scope = psidFilter ? `psid=${psidFilter}` : 'all subscribed';
      this.logger.log(
        `Ops send-reports (${scope}): bypass exam window ${schedule.minDays}-${schedule.maxDays} days` +
          (allowDuplicate
            ? ', allowDuplicate=true'
            : ', skip already sent today'),
      );
    }

    let mappings =
      await this.messengerRepository.findActiveSubscribedMappings();

    if (psidFilter) {
      mappings = mappings.filter((m) => m.psid === psidFilter);
      if (mappings.length === 0) {
        throw new BadRequestException(
          `No active subscribed mapping for psid=${psidFilter}`,
        );
      }
    }

    const concurrency = this.readConcurrency();
    const settled = await runBatched(mappings, concurrency, (mapping) =>
      this.processMappingForReport(mapping, {
        forceSend,
        skipAlreadySentToday,
        reportDate,
      }),
    );
    const results = settled
      .filter(
        (r): r is PromiseFulfilledResult<ClaimAndSendResult> =>
          r.status === 'fulfilled',
      )
      .map((r) => r.value);

    let sent = 0;
    let skipped = 0;
    let deferred = 0;
    let windowClosed = 0;
    let claimSkipped = 0;
    let retryQueued = 0;
    const failures: SendScheduledReportsResult['failures'] = [];

    for (const r of results) {
      sent += r.sent;
      skipped += r.skipped;
      deferred += r.deferred;
      windowClosed += r.windowClosed;
      claimSkipped += r.claimSkipped;
      retryQueued += r.retryQueued;
      failures.push(...r.failures);
    }

    return {
      total: mappings.length,
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

    // Single Wispace API call — supplies both shouldSend and examDate
    let examDateForOutbox: string | undefined;
    try {
      const userSchedule =
        await this.reportScheduleService.shouldSendReportToday(mapping.psid);
      examDateForOutbox = userSchedule.examDate;

      if (!forceSend && !userSchedule.shouldSend) {
        this.logger.log(
          `Skip PSID ${mapping.psid}: examDate=${userSchedule.examDate}, daysUntilExam=${userSchedule.daysUntilExam}, window=${userSchedule.minDays}-${userSchedule.maxDays}`,
        );
        return { ...ZERO, skipped: 1 };
      }
    } catch (err) {
      if (!forceSend) {
        this.logger.warn(
          `Skip PSID ${mapping.psid}: could not resolve exam schedule`,
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
