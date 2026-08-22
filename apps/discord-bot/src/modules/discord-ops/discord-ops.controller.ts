import {
  Body,
  Controller,
  HttpCode,
  Logger,
  Post,
  UseGuards,
} from '@nestjs/common';
import { IsString } from 'class-validator';
import { InternalApiKeyGuard } from '@wispace/bot-common';
import {
  createCalendarGetSessions,
  StudyReminderSyncService,
} from '@wispace/study-reminder-shared';
import { WispaceCalendarService } from '@wispace/wispace-client';
import { DopplerRuntimeSyncService } from '@wispace/doppler-sync';
import type { DopplerWebhookPayload } from '@wispace/doppler-sync';
import { DiscordReportCronService } from '../discord-chat/application/services/discord-report-cron.service';
import { PrivacyDataService } from '@wispace/database';

class PrivacyActionBody {
  @IsString()
  externalUserId!: string;
}

@Controller('discord')
@UseGuards(InternalApiKeyGuard)
export class DiscordOpsController {
  private readonly logger = new Logger(DiscordOpsController.name);

  constructor(
    private readonly reportCronService: DiscordReportCronService,
    private readonly studyReminderSyncService: StudyReminderSyncService,
    private readonly calendarService: WispaceCalendarService,
    private readonly dopplerRuntimeSyncService: DopplerRuntimeSyncService,
    private readonly privacyService: PrivacyDataService,
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
      // Authoritative calendar fetch before any stale-job cancellation.
      getSessions: createCalendarGetSessions(this.calendarService),
    });
  }

  @Post('privacy/unlink')
  @HttpCode(200)
  unlinkUser(@Body() body: PrivacyActionBody) {
    return this.privacyService.unlink('discord', body.externalUserId);
  }

  @Post('privacy/delete')
  @HttpCode(200)
  deleteUser(@Body() body: PrivacyActionBody) {
    return this.privacyService.delete('discord', body.externalUserId);
  }

  @Post('privacy/export')
  @HttpCode(200)
  exportUser(@Body() body: PrivacyActionBody) {
    return this.privacyService.export('discord', body.externalUserId);
  }
}
