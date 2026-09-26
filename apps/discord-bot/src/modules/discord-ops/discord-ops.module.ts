import { Module } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { BotCommonModule } from '@wispace/bot-common/guard';
import {
  ADVISORY_LOCKS,
  PgAdvisoryLockService,
} from '@wispace/bot-common/locks';
import { BotMetricsService } from '@wispace/bot-metrics';
import {
  PlatformAgentService,
  PlatformChatHistoryService,
  PlatformChatQueueService,
} from '@wispace/chat-agent';
import {
  PrivacyCleanupJobStore,
  PrivacyCleanupReconciler,
  PrivacyDataService,
} from '@wispace/database';
import { DISCORD_PRIVACY_DATA } from './application/ports/privacy-data.port';
import { PRIVACY_CLEANUP_STORES } from '@wispace/contracts';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { DiscordReportModule } from '../discord-chat/discord-report.module';
import { DiscordChatModule } from '../discord-chat/discord-chat.module';
import { DiscordStudyReminderModule } from '../discord-study-reminder/discord-study-reminder.module';
import { WispaceModule } from '../wispace/wispace.module';
import { DiscordOpsController } from './discord-ops.controller';

@Module({
  imports: [
    BotCommonModule,
    DatabaseModule,
    DiscordReportModule,
    DiscordChatModule,
    DiscordStudyReminderModule,
    // Authoritative session source for direct sync entry points (#111).
    WispaceModule,
  ],
  controllers: [DiscordOpsController],
  providers: [
    { provide: DISCORD_PRIVACY_DATA, useExisting: PrivacyDataService },
    {
      provide: PrivacyCleanupReconciler,
      useFactory: (
        dataSource: DataSource,
        pgLock: PgAdvisoryLockService,
        historyService: PlatformChatHistoryService,
        queueService: PlatformChatQueueService,
        clarificationAgent: PlatformAgentService,
        metrics: BotMetricsService,
        cleanupJobs: PrivacyCleanupJobStore,
      ) =>
        new PrivacyCleanupReconciler(
          dataSource,
          'discord',
          {
            platform: 'discord',
            applicableStores: PRIVACY_CLEANUP_STORES.filter(
              (store) => store !== 'display_name_cache',
            ),
            clearHistory: (id) => historyService.clear(id),
            clearQueuedWork: (id) => queueService.clear(id),
            clearClarification: (id) =>
              clarificationAgent.clearClarificationState(id),
          },
          {
            pgLock,
            lockId: ADVISORY_LOCKS.PRIVACY_CLEANUP_DISCORD,
            metrics,
            store: cleanupJobs,
          },
        ),
      inject: [
        DataSource,
        PgAdvisoryLockService,
        PlatformChatHistoryService,
        PlatformChatQueueService,
        PlatformAgentService,
        BotMetricsService,
        PrivacyCleanupJobStore,
      ],
    },
  ],
})
export class DiscordOpsModule {}
