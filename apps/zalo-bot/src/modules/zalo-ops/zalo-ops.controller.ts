import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { IsBoolean, IsNumber, IsOptional, IsPositive } from 'class-validator';
import { InternalApiKeyGuard } from '@wispace/bot-common';
import {
  createCalendarGetSessions,
  StudyReminderSyncService,
} from '@wispace/study-reminder-shared';
import { WispaceCalendarService } from '@wispace/wispace-client';
import { DopplerRuntimeSyncService } from '@wispace/doppler-sync';
import type { DopplerWebhookPayload } from '@wispace/doppler-sync';
import { ZaloReportCronService } from '../zalo-chat/infrastructure/persistence/zalo-report-cron.service';

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
export class ZaloOpsController {
  constructor(
    private readonly reportCronService: ZaloReportCronService,
    private readonly studyReminderSyncService: StudyReminderSyncService,
    private readonly calendarService: WispaceCalendarService,
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
    return this.reportCronService.sendDailyReports({
      forceSend: body?.forceSend === true,
    });
  }

  @Post('study-calendar/sync')
  @HttpCode(200)
  syncStudyCalendarAfterChange(@Body() body: SyncStudyCalendarBody) {
    return this.studyReminderSyncService.syncUpcomingSessions({
      userId: body.userId,
      platform: 'zalo',
      // Authoritative calendar fetch before any stale-job cancellation.
      getSessions: createCalendarGetSessions(this.calendarService),
    });
  }

  @Post('sync-study-reminders')
  @HttpCode(200)
  syncStudyReminders() {
    return this.studyReminderSyncService.syncUpcomingSessions({
      platform: 'zalo',
      // Authoritative calendar fetch before any stale-job cancellation.
      getSessions: createCalendarGetSessions(this.calendarService),
    });
  }
}
