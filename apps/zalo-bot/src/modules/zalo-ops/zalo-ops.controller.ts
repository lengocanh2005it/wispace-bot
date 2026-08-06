import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import { InternalApiKeyGuard } from '@wispace/bot-common';
import { StudyReminderSyncService } from '@wispace/study-reminder-shared';
import { ZaloReportCronService } from '../zalo-chat/infrastructure/persistence/zalo-report-cron.service';

@Controller('zalo')
@UseGuards(InternalApiKeyGuard)
export class ZaloOpsController {
  constructor(
    private readonly reportCronService: ZaloReportCronService,
    private readonly studyReminderSyncService: StudyReminderSyncService,
  ) {}

  @Post('send-reports')
  @HttpCode(200)
  sendReports() {
    return this.reportCronService.sendDailyReports();
  }

  @Post('study-calendar/sync')
  @HttpCode(200)
  syncStudyCalendarAfterChange(@Body() body: { userId: number }) {
    const userId = Number(body?.userId);
    if (!Number.isFinite(userId) || userId <= 0) {
      throw new BadRequestException('userId must be a positive number');
    }
    return this.studyReminderSyncService.syncUpcomingSessions({
      userId,
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
