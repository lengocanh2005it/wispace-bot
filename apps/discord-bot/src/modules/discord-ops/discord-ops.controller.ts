import {
  Body,
  Controller,
  HttpCode,
  Logger,
  Post,
  UseGuards,
} from '@nestjs/common';
import { InternalApiKeyGuard } from '@wispace/bot-common';
import { StudyReminderSyncService } from '@wispace/study-reminder-shared';
import { DopplerRuntimeSyncService } from '@wispace/doppler-sync';
import type { DopplerWebhookPayload } from '@wispace/doppler-sync';
import { DiscordReportCronService } from '../discord-chat/application/services/discord-report-cron.service';

@Controller('discord')
@UseGuards(InternalApiKeyGuard)
export class DiscordOpsController {
  private readonly logger = new Logger(DiscordOpsController.name);

  constructor(
    private readonly reportCronService: DiscordReportCronService,
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
