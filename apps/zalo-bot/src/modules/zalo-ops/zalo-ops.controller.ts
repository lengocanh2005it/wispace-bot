import {
  Body,
  Controller,
  HttpCode,
  Optional,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { IsBoolean, IsNumber, IsOptional, IsPositive } from 'class-validator';
import { InternalApiKeyGuard } from '@wispace/bot-common/guard';
import { PlatformOpsController } from '@wispace/bot-common/health';
import {
  createCalendarGetSessions,
  StudyReminderSyncService,
} from '@wispace/study-reminder-shared';
import { WispaceCalendarService } from '@wispace/wispace-client';
import {
  PrivacyDataService,
  PRIVACY_CLEANUP_STORES,
  type PrivacyStateCleanup,
} from '@wispace/database';
import { BotMetricsService } from '@wispace/bot-metrics';
import { ZaloReportCronService } from '../zalo-chat/infrastructure/persistence/zalo-report-cron.service';
import {
  PlatformAgentService,
  PlatformChatHistoryService,
  PlatformChatQueueService,
} from '@wispace/chat-agent';

class SyncStudyCalendarBody {
  @IsNumber()
  @IsPositive()
  userId!: number;
}

class SendReportsBody {
  @IsOptional()
  @IsBoolean()
  forceSend?: boolean;
}

@Controller('zalo')
@UseGuards(InternalApiKeyGuard, ThrottlerGuard)
export class ZaloOpsController extends PlatformOpsController {
  constructor(
    private readonly studyReminderSyncService: StudyReminderSyncService,
    private readonly reportCronService: ZaloReportCronService,
    private readonly calendarService: WispaceCalendarService,
    privacyService: PrivacyDataService,
    clarificationAgent: PlatformAgentService,
    historyService: PlatformChatHistoryService,
    queueService: PlatformChatQueueService,
    @Optional() metrics?: BotMetricsService,
  ) {
    super({
      sendReports: (body?: SendReportsBody) =>
        reportCronService.sendDailyReports({
          forceSend: body?.forceSend === true,
        }),
      syncStudyReminders: () =>
        studyReminderSyncService.syncUpcomingSessions({
          platform: 'zalo',
          getSessions: createCalendarGetSessions(calendarService),
        }),
      unlinkUser: async (externalUserId) => {
        const result = await privacyService.unlink(
          'zalo',
          externalUserId,
          zaloPrivacyCleanup(
            historyService,
            queueService,
            clarificationAgent,
            metrics,
            'unlink',
          ),
        );
        return result;
      },
      deleteUser: async (externalUserId) => {
        return privacyService.delete(
          'zalo',
          externalUserId,
          zaloPrivacyCleanup(
            historyService,
            queueService,
            clarificationAgent,
            metrics,
            'delete',
          ),
        );
      },
      exportUser: (externalUserId) =>
        privacyService.export('zalo', externalUserId),
      clearClarification: (externalUserId) =>
        clarificationAgent.clearClarificationState(externalUserId),
    });
  }

  // Preserve request-body validation while delegating through the shared route.
  @Post('send-reports')
  @HttpCode(200)
  sendReports(@Body() body?: SendReportsBody) {
    return this.ops.sendReports(body);
  }

  @Post('study-calendar/sync')
  @HttpCode(200)
  syncStudyCalendarAfterChange(@Body() body: SyncStudyCalendarBody) {
    return this.studyReminderSyncService.syncUpcomingSessions({
      userId: body.userId,
      platform: 'zalo',
      getSessions: createCalendarGetSessions(this.calendarService),
    });
  }
}

function zaloPrivacyCleanup(
  historyService: PlatformChatHistoryService,
  queueService: PlatformChatQueueService,
  clarificationAgent: PlatformAgentService,
  metrics: BotMetricsService | undefined,
  operation: 'unlink' | 'delete',
): PrivacyStateCleanup {
  return {
    platform: 'zalo',
    applicableStores: PRIVACY_CLEANUP_STORES.filter(
      (store) => store !== 'display_name_cache',
    ),
    clearHistory: (id) => historyService.clear(id),
    clearQueuedWork: (id) => queueService.clear(id),
    clearClarification: (id) => clarificationAgent.clearClarificationState(id),
    onAttempt: (store, outcome) =>
      metrics?.incPrivacyCleanupAttempt('zalo', operation, store, outcome),
  };
}
