import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  StudyReminderSyncService,
  StudyReminderDispatchService,
  StudyReminderWorkerService,
  StudyReminderJobEntity,
  createStudyReminderProviders,
  createCalendarGetSessions,
  GET_SESSIONS,
} from '@wispace/study-reminder-shared';
import { ZaloAccountLinkEntity } from '../../infrastructure/database/entities/zalo-account-link.entity';
import { ZaloOauthStateEntity } from '../../infrastructure/database/entities/zalo-oauth-state.entity';
import { BotCommonModule } from '@wispace/bot-common/guard';
import { ADVISORY_LOCKS } from '@wispace/bot-common/locks';
import { ZaloChatModule } from '../zalo-chat/zalo-chat.module';
import { ZaloOutboundService } from '../zalo-chat/application/services/zalo-outbound.service';
import { ZaloWispaceModule } from '../wispace/zalo-wispace.module';
import { WispaceCalendarService } from '@wispace/wispace-client';
import {
  CanonicalPlatformService,
  WebActivityService,
} from '@wispace/database';
import { BotMetricsService } from '@wispace/bot-metrics';
import { DatabaseModule } from '../../infrastructure/database/database.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      StudyReminderJobEntity,
      ZaloAccountLinkEntity,
      ZaloOauthStateEntity,
    ]),
    BotCommonModule,
    ZaloChatModule,
    ZaloWispaceModule,
    DatabaseModule,
  ],
  providers: [
    {
      // Worker session source — structural bridge over the concrete WISPACE
      // calendar client wired by ZaloWispaceModule (#424).
      provide: GET_SESSIONS,
      useFactory: (calendarService: WispaceCalendarService) =>
        createCalendarGetSessions(calendarService),
      inject: [WispaceCalendarService],
    },
    ...createStudyReminderProviders({
      platform: 'zalo',
      mappingTable: 'zalo_account_links',
      mappingEntity: ZaloAccountLinkEntity,
      outboundService: ZaloOutboundService,
      canonicalPlatformService: CanonicalPlatformService,
      dormancyGate: WebActivityService,
      dormancySuppressionMetric: BotMetricsService,
      // #777: per-platform lock ids — Zalo no longer contends with the
      // fleet on the shared sync lock.
      workerLockIds: {
        sync: ADVISORY_LOCKS.ZALO_STUDY_REMINDER_SYNC,
        cleanup: ADVISORY_LOCKS.ZALO_STUDY_REMINDER_CLEANUP,
        rollover: ADVISORY_LOCKS.ZALO_STUDY_REMINDER_ROLLOVER,
      },
    }),
  ],
  exports: [
    StudyReminderSyncService,
    StudyReminderDispatchService,
    StudyReminderWorkerService,
  ],
})
export class ZaloStudyReminderModule {}
