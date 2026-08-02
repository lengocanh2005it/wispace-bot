import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import { InternalApiKeyGuard } from '@wispace/bot-common';
import { StudyReminderSyncService } from '@messenger/modules/study-reminder/application/services/study-reminder-sync.service';
import { StudyReminderWorkerService } from '@messenger/modules/study-reminder/application/services/study-reminder-worker.service';
import { MessengerMappingService } from '@messenger/modules/messenger/application/services/messenger-mapping.service';
import {
  DopplerRuntimeSyncService,
  type DopplerWebhookPayload,
} from '../../application/services/doppler-runtime-sync.service';
import { ReportCronService } from '../../application/services/report-cron.service';
import { ReportSendRetryDispatchService } from '../../application/services/report-send-retry-dispatch.service';

interface SyncStudyCalendarBody {
  userId: number;
}

interface RelinkMappingBody {
  psid: string;
  userId: number;
  /**
   * Cho phép đổi mapping khi PSID đã map user khác (L4).
   * Mặc định false — cần ops chủ động bật.
   */
  allowRelink?: boolean;
}

interface SendReportsBody {
  /** Chỉ gửi một học viên (ops recovery R5). */
  psid?: string;
  /**
   * Gửi lại dù đã có SCHEDULED_LEARNING_REPORT hôm nay.
   * Mặc định false — tránh trùng báo cáo.
   */
  allowDuplicate?: boolean;
}

@Controller('messenger')
@UseGuards(InternalApiKeyGuard)
export class SchedulerController {
  constructor(
    private readonly reportCronService: ReportCronService,
    private readonly studyReminderSyncService: StudyReminderSyncService,
    private readonly studyReminderWorkerService: StudyReminderWorkerService,
    private readonly messengerMappingService: MessengerMappingService,
    private readonly reportSendRetryDispatchService: ReportSendRetryDispatchService,
    private readonly dopplerRuntimeSyncService: DopplerRuntimeSyncService,
  ) {}

  @Post('ops/doppler-sync')
  @HttpCode(202)
  dopplerRuntimeSync(@Body() body?: DopplerWebhookPayload) {
    return this.dopplerRuntimeSyncService.scheduleSync(body);
  }

  @Post('send-reports')
  @HttpCode(200)
  sendReports(@Body() body?: SendReportsBody) {
    return this.reportCronService.sendScheduledReports({
      forceSend: true,
      externalUserId: body?.psid?.trim(),
      allowDuplicate: body?.allowDuplicate === true,
    });
  }

  @Post('send-reports/retry-dispatch')
  @HttpCode(200)
  dispatchReportSendRetries() {
    return this.reportSendRetryDispatchService.dispatchDueReportRetries();
  }

  @Post('mapping/relink')
  @HttpCode(200)
  relinkMessengerMapping(@Body() body: RelinkMappingBody) {
    const userId = Number(body?.userId);
    const psid = body?.psid?.trim();

    if (!psid) {
      throw new BadRequestException('psid is required');
    }

    if (!Number.isFinite(userId) || userId <= 0) {
      throw new BadRequestException('userId must be a positive number');
    }

    return this.messengerMappingService.relinkPsidToUserId({
      psid,
      userId,
      notifyUser: false,
      allowRelink: body?.allowRelink === true,
    });
  }

  @Post('study-calendar/sync')
  @HttpCode(200)
  syncStudyCalendarAfterChange(@Body() body: SyncStudyCalendarBody) {
    const userId = Number(body?.userId);
    if (!Number.isFinite(userId) || userId <= 0) {
      throw new BadRequestException('userId must be a positive number');
    }

    return this.studyReminderSyncService.syncUpcomingSessions({ userId });
  }

  @Post('sync-study-reminders')
  @HttpCode(200)
  syncStudyReminders() {
    return this.studyReminderSyncService.syncUpcomingSessions();
  }

  @Post('send-study-reminders')
  @HttpCode(200)
  sendStudyReminders() {
    return this.studyReminderWorkerService.runSyncAndDispatch();
  }

  @Post('study-reminder/evening-rollover')
  @HttpCode(200)
  runStudyReminderEveningRollover() {
    return this.studyReminderWorkerService.runEveningRollover();
  }
}
