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
import { DiscordAccountLinkEntity } from '../../infrastructure/database/entities/discord-account-link.entity';
import { BotCommonModule } from '@wispace/bot-common/guard';
import { ADVISORY_LOCKS } from '@wispace/bot-common/locks';
import { DiscordOutboundModule } from '../discord-chat/discord-outbound.module';
import { WispaceModule } from '../wispace/wispace.module';
import { WispaceCalendarService } from '@wispace/wispace-client';
import { DiscordOutboundService } from '../discord-chat/application/services/discord-outbound.service';
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
      DiscordAccountLinkEntity,
    ]),
    BotCommonModule,
    DiscordOutboundModule,
    WispaceModule,
    DatabaseModule,
  ],
  providers: [
    {
      // Worker session source — structural bridge over the concrete WISPACE
      // calendar client wired by WispaceModule (#424).
      provide: GET_SESSIONS,
      useFactory: (calendarService: WispaceCalendarService) =>
        createCalendarGetSessions(calendarService),
      inject: [WispaceCalendarService],
    },
    ...createStudyReminderProviders({
      platform: 'discord',
      mappingTable: 'discord_account_links',
      mappingEntity: DiscordAccountLinkEntity,
      outboundService: DiscordOutboundService,
      canonicalPlatformService: CanonicalPlatformService,
      dormancyGate: WebActivityService,
      dormancySuppressionMetric: BotMetricsService,
      // #777: per-platform lock ids — Discord no longer contends with the
      // fleet on the shared sync lock.
      workerLockIds: {
        sync: ADVISORY_LOCKS.DISCORD_STUDY_REMINDER_SYNC,
        cleanup: ADVISORY_LOCKS.DISCORD_STUDY_REMINDER_CLEANUP,
        rollover: ADVISORY_LOCKS.DISCORD_STUDY_REMINDER_ROLLOVER,
      },
    }),
  ],
  exports: [
    StudyReminderSyncService,
    StudyReminderDispatchService,
    StudyReminderWorkerService,
  ],
})
export class DiscordStudyReminderModule {}
