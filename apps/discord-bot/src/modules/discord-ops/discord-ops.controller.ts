import { Controller, HttpCode, Logger, Post, UseGuards } from '@nestjs/common';
import { InternalApiKeyGuard } from '@wispace/bot-common';
import { StudyReminderSyncService } from '@wispace/study-reminder-shared';
import { DiscordReportCronService } from '../discord-chat/application/services/discord-report-cron.service';

@Controller('discord')
@UseGuards(InternalApiKeyGuard)
export class DiscordOpsController {
  private readonly logger = new Logger(DiscordOpsController.name);

  constructor(
    private readonly reportCronService: DiscordReportCronService,
    private readonly studyReminderSyncService: StudyReminderSyncService,
  ) {}

  @Post('send-reports')
  @HttpCode(200)
  sendReports() {
    return this.reportCronService.sendScheduledReports();
  }

  @Post('sync-study-reminders')
  @HttpCode(200)
  syncStudyReminders() {
    return this.studyReminderSyncService.syncUpcomingSessions({
      platform: 'discord',
    });
  }
}
