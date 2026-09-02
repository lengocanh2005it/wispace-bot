import { Controller, UseGuards } from '@nestjs/common';
import { InternalApiKeyGuard } from '@wispace/bot-common/guard';
import { PlatformOpsController } from '@wispace/bot-common/health';
import {
  createCalendarGetSessions,
  StudyReminderSyncService,
} from '@wispace/study-reminder-shared';
import { WispaceCalendarService } from '@wispace/wispace-client';
import { PrivacyDataService } from '@wispace/database';
import { DiscordReportCronService } from '../discord-chat/application/services/discord-report-cron.service';
import {
  PlatformAgentService,
  PlatformChatHistoryService,
  PlatformChatQueueService,
} from '@wispace/chat-agent';
import { CrossPlatformRedisCleaner } from '@wispace/bot-common/redis';

@Controller('discord')
@UseGuards(InternalApiKeyGuard)
export class DiscordOpsController extends PlatformOpsController {
  constructor(
    reportCronService: DiscordReportCronService,
    studyReminderSyncService: StudyReminderSyncService,
    calendarService: WispaceCalendarService,
    privacyService: PrivacyDataService,
    clarificationAgent: PlatformAgentService,
    historyService: PlatformChatHistoryService,
    queueService: PlatformChatQueueService,
    redisCleaner: CrossPlatformRedisCleaner,
  ) {
    super({
      sendReports: () => reportCronService.sendScheduledReports(),
      syncStudyReminders: () =>
        studyReminderSyncService.syncUpcomingSessions({
          platform: 'discord',
          getSessions: createCalendarGetSessions(calendarService),
        }),
      unlinkUser: async (externalUserId) => {
        const result = await privacyService.unlink('discord', externalUserId, {
          clearHistory: (id) => redisCleaner.clean(id),
          clearQueuedWork: (id) => queueService.clear(id),
          clearClarification: (id) =>
            clarificationAgent.clearClarificationState(id),
        });
        return result;
      },
      deleteUser: async (externalUserId) => {
        await privacyService.delete('discord', externalUserId, {
          clearHistory: (id) => redisCleaner.clean(id),
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
