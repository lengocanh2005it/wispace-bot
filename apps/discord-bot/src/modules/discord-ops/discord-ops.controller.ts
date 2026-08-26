import { Controller, UseGuards } from '@nestjs/common';
import {
  InternalApiKeyGuard,
  PlatformOpsController,
} from '@wispace/bot-common';
import {
  createCalendarGetSessions,
  StudyReminderSyncService,
} from '@wispace/study-reminder-shared';
import { WispaceCalendarService } from '@wispace/wispace-client';
import { DopplerRuntimeSyncService } from '@wispace/doppler-sync';
import type { DopplerWebhookPayload } from '@wispace/doppler-sync';
import { PrivacyDataService } from '@wispace/database';
import { DiscordReportCronService } from '../discord-chat/application/services/discord-report-cron.service';

@Controller('discord')
@UseGuards(InternalApiKeyGuard)
export class DiscordOpsController extends PlatformOpsController<DopplerWebhookPayload> {
  constructor(
    reportCronService: DiscordReportCronService,
    studyReminderSyncService: StudyReminderSyncService,
    calendarService: WispaceCalendarService,
    dopplerRuntimeSyncService: DopplerRuntimeSyncService,
    privacyService: PrivacyDataService,
  ) {
    super({
      dopplerRuntimeSync: (body) =>
        dopplerRuntimeSyncService.scheduleSync(body),
      sendReports: () => reportCronService.sendScheduledReports(),
      syncStudyReminders: () =>
        studyReminderSyncService.syncUpcomingSessions({
          platform: 'discord',
          getSessions: createCalendarGetSessions(calendarService),
        }),
      unlinkUser: (externalUserId) =>
        privacyService.unlink('discord', externalUserId),
      deleteUser: (externalUserId) =>
        privacyService.delete('discord', externalUserId),
      exportUser: (externalUserId) =>
        privacyService.export('discord', externalUserId),
    });
  }
}
