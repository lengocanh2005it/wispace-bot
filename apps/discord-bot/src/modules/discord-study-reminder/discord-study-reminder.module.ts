import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SchedulerRegistry } from '@nestjs/schedule';
import { PgAdvisoryLockService } from '@wispace/bot-common';
import {
  StudyReminderScheduleService,
  StudyReminderSyncService,
  StudyReminderDispatchService,
  StudyReminderWorkerService,
  StudyReminderJobEntity,
  TypeormStudyReminderJobRepository,
  MESSAGE_SENDER,
  MAPPING_READER,
  STUDY_REMINDER_JOB_REPOSITORY,
  DISPLAY_NAME_CACHE,
} from '@wispace/study-reminder-shared';
import { DiscordAccountLinkEntity } from '../../infrastructure/database/entities/discord-account-link.entity';
import { BotCommonModule } from '@wispace/bot-common';
import { DiscordChatModule } from '../discord-chat/discord-chat.module';
import { DiscordOutboundModule } from '../discord-chat/discord-outbound.module';
import { WispaceModule } from '../wispace/wispace.module';
import { WispaceCalendarService } from '../wispace/application/services/wispace-calendar.service';
import { DiscordStudyReminderMessageSenderService } from '../discord-chat/application/services/discord-study-reminder-message-sender.service';
import { DiscordMappingReaderAdapter } from '../discord-chat/infrastructure/persistence/discord-mapping-reader.adapter';
import { ConfigService } from '@nestjs/config';
import {
  REDIS_CLIENT,
  RedisUserDisplayNameCache,
  type RedisClientPort,
} from '@wispace/bot-common';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      StudyReminderJobEntity,
      DiscordAccountLinkEntity,
    ]),
    BotCommonModule,
    DiscordChatModule,
    DiscordOutboundModule,
    WispaceModule,
  ],
  providers: [
    {
      provide: MESSAGE_SENDER,
      useExisting: DiscordStudyReminderMessageSenderService,
    },
    {
      provide: MAPPING_READER,
      useExisting: DiscordMappingReaderAdapter,
    },
    {
      provide: STUDY_REMINDER_JOB_REPOSITORY,
      useExisting: TypeormStudyReminderJobRepository,
    },
    {
      provide: RedisUserDisplayNameCache,
      useFactory: (
        redisClient: RedisClientPort,
        configService: ConfigService,
      ) =>
        new RedisUserDisplayNameCache(redisClient, configService, {
          platform: 'discord',
        }),
      inject: [REDIS_CLIENT, ConfigService],
    },
    {
      provide: DISPLAY_NAME_CACHE,
      useExisting: RedisUserDisplayNameCache,
    },
    StudyReminderScheduleService,
    StudyReminderSyncService,
    StudyReminderDispatchService,
    {
      provide: StudyReminderWorkerService,
      useFactory: (...deps: unknown[]) =>
        new (StudyReminderWorkerService as never as new (
          ...args: unknown[]
        ) => StudyReminderWorkerService)(
          deps[0],
          deps[1],
          deps[2],
          deps[3],
          deps[4],
          deps[5],
          'discord',
          deps[6] && typeof deps[6] === 'object'
            ? (externalUserId: string) =>
                (deps[6] as WispaceCalendarService)
                  .getCalendarSessions(externalUserId, {
                    timeRange: 'upcoming',
                  })
                  .then((sessions) =>
                    sessions.map((s) => ({
                      calendarId: s.sessionKey,
                      sessionKey: s.sessionKey,
                      scheduledAt: s.scheduledAt,
                      topic: s.topic,
                    })),
                  )
            : undefined,
        ),
      inject: [
        StudyReminderSyncService,
        StudyReminderDispatchService,
        StudyReminderScheduleService,
        { token: SchedulerRegistry, optional: false },
        PgAdvisoryLockService,
        { token: STUDY_REMINDER_JOB_REPOSITORY, optional: true },
        WispaceCalendarService,
      ],
    },
    RedisUserDisplayNameCache,
    DiscordStudyReminderMessageSenderService,
    DiscordMappingReaderAdapter,
    TypeormStudyReminderJobRepository,
  ],
  exports: [
    StudyReminderSyncService,
    StudyReminderDispatchService,
    StudyReminderWorkerService,
  ],
})
export class DiscordStudyReminderModule {}
