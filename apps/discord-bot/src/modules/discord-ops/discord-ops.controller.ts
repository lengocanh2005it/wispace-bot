import { Controller, Optional, UseGuards } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { InternalApiKeyGuard } from '@wispace/bot-common/guard';
import { PlatformOpsController } from '@wispace/bot-common/health';
import {
  createCalendarGetSessions,
  StudyReminderSyncService,
} from '@wispace/study-reminder-shared/adapters';
import { WispaceCalendarService } from '@wispace/wispace-client/adapters';
import {
  PrivacyDataService,
  PRIVACY_CLEANUP_STORES,
  type PrivacyStateCleanup,
} from '@wispace/database';
import { BotMetricsService } from '@wispace/bot-metrics';
import { DiscordReportCronService } from '../discord-chat/application/services/discord-report-cron.service';
import {
  PlatformAgentService,
  PlatformChatHistoryService,
  PlatformChatQueueService,
} from '@wispace/chat-agent';

@Controller('discord')
@UseGuards(InternalApiKeyGuard, ThrottlerGuard)
export class DiscordOpsController extends PlatformOpsController {
  constructor(
    reportCronService: DiscordReportCronService,
    studyReminderSyncService: StudyReminderSyncService,
    calendarService: WispaceCalendarService,
    privacyService: PrivacyDataService,
    clarificationAgent: PlatformAgentService,
    historyService: PlatformChatHistoryService,
    queueService: PlatformChatQueueService,
    @Optional() metrics?: BotMetricsService,
  ) {
    super({
      sendReports: () => reportCronService.sendScheduledReports(),
      syncStudyReminders: () =>
        studyReminderSyncService.syncUpcomingSessions({
          platform: 'discord',
          getSessions: createCalendarGetSessions(calendarService),
        }),
      unlinkUser: async (externalUserId, expectedMapping) => {
        const result = await privacyService.unlink(
          'discord',
          externalUserId,
          discordPrivacyCleanup(
            historyService,
            queueService,
            clarificationAgent,
            metrics,
            'unlink',
          ),
          expectedMapping,
        );
        return result;
      },
      deleteUser: async (externalUserId, expectedMapping) => {
        return privacyService.delete(
          'discord',
          externalUserId,
          discordPrivacyCleanup(
            historyService,
            queueService,
            clarificationAgent,
            metrics,
            'delete',
          ),
          expectedMapping,
        );
      },
      exportUser: (externalUserId) =>
        privacyService.export('discord', externalUserId),
      clearClarification: (externalUserId) =>
        clarificationAgent.clearClarificationState(externalUserId),
    });
  }
}

function discordPrivacyCleanup(
  historyService: PlatformChatHistoryService,
  queueService: PlatformChatQueueService,
  clarificationAgent: PlatformAgentService,
  metrics: BotMetricsService | undefined,
  operation: 'unlink' | 'delete',
): PrivacyStateCleanup {
  return {
    platform: 'discord',
    applicableStores: PRIVACY_CLEANUP_STORES.filter(
      (store) => store !== 'display_name_cache',
    ),
    clearHistory: (id) => historyService.clear(id),
    clearQueuedWork: (id) => queueService.clear(id),
    clearClarification: (id) => clarificationAgent.clearClarificationState(id),
    onAttempt: (store, outcome) =>
      metrics?.incPrivacyCleanupAttempt('discord', operation, store, outcome),
  };
}
