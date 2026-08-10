import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { IsNumber, IsPositive } from 'class-validator';
import { InternalApiKeyGuard } from '@wispace/bot-common';
import { StudyReminderSyncService } from '@wispace/study-reminder-shared';
import { DopplerRuntimeSyncService } from '@wispace/doppler-sync';
import type { DopplerWebhookPayload } from '@wispace/doppler-sync';
import { ZaloReportCronService } from '../zalo-chat/infrastructure/persistence/zalo-report-cron.service';

class SyncStudyCalendarBody {
  @IsNumber()
  @IsPositive()
  userId!: number;
}

@Controller('zalo')
@UseGuards(InternalApiKeyGuard)
export class ZaloOpsController {
  constructor(
    private readonly reportCronService: ZaloReportCronService,
    private readonly studyReminderSyncService: StudyReminderSyncService,
    private readonly dopplerRuntimeSyncService: DopplerRuntimeSyncService,
  ) {}

  @Post('ops/doppler-sync')
  @HttpCode(202)
  dopplerRuntimeSync(@Body() body?: DopplerWebhookPayload) {
    return this.dopplerRuntimeSyncService.scheduleSync(body);
  }

  @Post('send-reports')
  @HttpCode(200)
  sendReports() {
    return this.reportCronService.sendDailyReports();
  }

  @Post('study-calendar/sync')
  @HttpCode(200)
  syncStudyCalendarAfterChange(@Body() body: SyncStudyCalendarBody) {
    return this.studyReminderSyncService.syncUpcomingSessions({
      userId: body.userId,
      platform: 'zalo',
    });
  }

  @Post('sync-study-reminders')
  @HttpCode(200)
  syncStudyReminders() {
    return this.studyReminderSyncService.syncUpcomingSessions({
      platform: 'zalo',
    });
  }
}
