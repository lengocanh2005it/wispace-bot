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
  PRIVACY_CLEANUP_STORES,
  PrivacyCleanupJobStore,
  PrivacyCleanupReconciler,
} from '@wispace/database';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { ZaloReportModule } from '../zalo-chat/zalo-report.module';
import { ZaloChatModule } from '../zalo-chat/zalo-chat.module';
import { ZaloStudyReminderModule } from '../zalo-study-reminder/zalo-study-reminder.module';
import { ZaloWispaceModule } from '../wispace/zalo-wispace.module';
import { ZaloOpsController } from './zalo-ops.controller';

@Module({
  imports: [
    BotCommonModule,
    DatabaseModule,
    ZaloReportModule,
    ZaloChatModule,
    ZaloStudyReminderModule,
    // Authoritative session source for direct sync entry points (#111).
    ZaloWispaceModule,
  ],
  controllers: [ZaloOpsController],
  providers: [
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
          'zalo',
          {
            platform: 'zalo',
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
            lockId: ADVISORY_LOCKS.PRIVACY_CLEANUP_ZALO,
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
export class ZaloOpsModule {}
