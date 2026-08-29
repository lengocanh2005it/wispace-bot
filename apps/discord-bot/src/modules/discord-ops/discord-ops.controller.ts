import { Controller, UseGuards } from '@nestjs/common';
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
import { DiscordReportCronService } from '../discord-chat/application/services/discord-report-cron.service';
import {
  PlatformAgentService,
  PlatformChatHistoryService,
  PlatformChatQueueService,
} from '@wispace/chat-agent';

@Controller('discord')
@UseGuards(InternalApiKeyGuard)
export class DiscordOpsController extends PlatformOpsController<DopplerWebhookPayload> {
  constructor(
    reportCronService: DiscordReportCronService,
    studyReminderSyncService: StudyReminderSyncService,
    calendarService: WispaceCalendarService,
    dopplerRuntimeSyncService: DopplerRuntimeSyncService,
    privacyService: PrivacyDataService,
    clarificationAgent: PlatformAgentService,
    historyService: PlatformChatHistoryService,
    queueService: PlatformChatQueueService,
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
      unlinkUser: async (externalUserId) => {
        const result = await privacyService.unlink('discord', externalUserId, {
          clearHistory: (id) => historyService.clear(id),
          clearQueuedWork: (id) => queueService.clear(id),
          clearClarification: (id) =>
            clarificationAgent.clearClarificationState(id),
        });
        return result;
      },
      deleteUser: async (externalUserId) => {
        await privacyService.delete('discord', externalUserId, {
          clearHistory: (id) => historyService.clear(id),
          clearQueuedWork: (id) => queueService.clear(id),
          clearClarification: (id) =>
            clarificationAgent.clearClarificationState(id),
        });
      },
      exportUser: (externalUserId) =>
        privacyService.export('discord', externalUserId),
      clearClarification: (externalUserId) =>
        clarificationAgent.clearClarificationState(externalUserId),
    });
  }
}
