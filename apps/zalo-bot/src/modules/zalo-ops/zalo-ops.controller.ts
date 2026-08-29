import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { IsBoolean, IsNumber, IsOptional, IsPositive } from 'class-validator';
import { InternalApiKeyGuard } from '@wispace/bot-common/guard';
import { PlatformOpsController } from '@wispace/bot-common/health';
import {
  createCalendarGetSessions,
  StudyReminderSyncService,
} from '@wispace/study-reminder-shared';
import { WispaceCalendarService } from '@wispace/wispace-client';
import { DopplerRuntimeSyncService } from '@wispace/doppler-sync';
import type { DopplerWebhookPayload } from '@wispace/doppler-sync';
import { PrivacyDataService } from '@wispace/database';
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
@UseGuards(InternalApiKeyGuard)
export class ZaloOpsController extends PlatformOpsController<DopplerWebhookPayload> {
  constructor(
    private readonly studyReminderSyncService: StudyReminderSyncService,
    private readonly reportCronService: ZaloReportCronService,
    private readonly calendarService: WispaceCalendarService,
    dopplerRuntimeSyncService: DopplerRuntimeSyncService,
    privacyService: PrivacyDataService,
    clarificationAgent: PlatformAgentService,
    historyService: PlatformChatHistoryService,
    queueService: PlatformChatQueueService,
  ) {
    super({
      dopplerRuntimeSync: (body) =>
        dopplerRuntimeSyncService.scheduleSync(body),
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
        const result = await privacyService.unlink('zalo', externalUserId, {
          clearHistory: (id) => historyService.clear(id),
          clearQueuedWork: (id) => queueService.clear(id),
          clearClarification: (id) =>
            clarificationAgent.clearClarificationState(id),
        });
        return result;
      },
      deleteUser: async (externalUserId) => {
        await privacyService.delete('zalo', externalUserId, {
          clearHistory: (id) => historyService.clear(id),
          clearQueuedWork: (id) => queueService.clear(id),
          clearClarification: (id) =>
            clarificationAgent.clearClarificationState(id),
        });
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
