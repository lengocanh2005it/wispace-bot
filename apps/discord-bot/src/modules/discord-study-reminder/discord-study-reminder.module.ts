import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  StudyReminderSyncService,
  StudyReminderDispatchService,
  StudyReminderWorkerService,
  StudyReminderJobEntity,
  createStudyReminderProviders,
} from '@wispace/study-reminder-shared';
import { DiscordAccountLinkEntity } from '../../infrastructure/database/entities/discord-account-link.entity';
import { BotCommonModule } from '@wispace/bot-common/guard';
import { DiscordOutboundModule } from '../discord-chat/discord-outbound.module';
import { WispaceModule } from '../wispace/wispace.module';
import { WispaceCalendarService } from '@wispace/wispace-client';
import { DiscordOutboundService } from '../discord-chat/application/services/discord-outbound.service';
import { WebActivityService } from '@wispace/database';
import { BotMetricsService } from '@wispace/bot-metrics';
import { DatabaseModule } from '../../infrastructure/database/database.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      StudyReminderJobEntity,
      DiscordAccountLinkEntity,
    ]),
    BotCommonModule,
    DiscordOutboundModule,
    WispaceModule,
    DatabaseModule,
  ],
  providers: createStudyReminderProviders({
    platform: 'discord',
    mappingTable: 'discord_account_links',
    mappingEntity: DiscordAccountLinkEntity,
    outboundService: DiscordOutboundService,
    calendarService: WispaceCalendarService,
    dormancyGate: WebActivityService,
    dormancySuppressionMetric: BotMetricsService,
  }),
  exports: [
    StudyReminderSyncService,
    StudyReminderDispatchService,
    StudyReminderWorkerService,
  ],
})
export class DiscordStudyReminderModule {}
