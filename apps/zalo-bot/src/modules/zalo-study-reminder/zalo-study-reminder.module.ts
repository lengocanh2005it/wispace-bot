import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  StudyReminderSyncService,
  StudyReminderDispatchService,
  StudyReminderWorkerService,
  StudyReminderJobEntity,
  createStudyReminderProviders,
} from '@wispace/study-reminder-shared';
import { ZaloAccountLinkEntity } from '../../infrastructure/database/entities/zalo-account-link.entity';
import { ZaloOauthStateEntity } from '../../infrastructure/database/entities/zalo-oauth-state.entity';
import { BotCommonModule } from '@wispace/bot-common/guard';
import { ZaloChatModule } from '../zalo-chat/zalo-chat.module';
import { ZaloOutboundService } from '../zalo-chat/application/services/zalo-outbound.service';
import { ZaloWispaceModule } from '../wispace/zalo-wispace.module';
import { WispaceCalendarService } from '@wispace/wispace-client';

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
  ],
  providers: createStudyReminderProviders({
    platform: 'zalo',
    mappingTable: 'zalo_account_links',
    mappingEntity: ZaloAccountLinkEntity,
    outboundService: ZaloOutboundService,
    calendarService: WispaceCalendarService,
  }),
  exports: [
    StudyReminderSyncService,
    StudyReminderDispatchService,
    StudyReminderWorkerService,
  ],
})
export class ZaloStudyReminderModule {}
