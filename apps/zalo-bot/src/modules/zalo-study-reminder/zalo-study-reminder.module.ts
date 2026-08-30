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
import { ZaloChatModule } from '../zalo-chat/zalo-chat.module';
import { ZaloOutboundService } from '../zalo-chat/application/services/zalo-outbound.service';
import { ZaloWispaceModule } from '../wispace/zalo-wispace.module';
import { WispaceCalendarService } from '@wispace/wispace-client';
import { WebActivityService } from '@wispace/database';
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
      dormancyGate: WebActivityService,
      dormancySuppressionMetric: BotMetricsService,
    }),
  ],
  exports: [
    StudyReminderSyncService,
    StudyReminderDispatchService,
    StudyReminderWorkerService,
  ],
})
export class ZaloStudyReminderModule {}
