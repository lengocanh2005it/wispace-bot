import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SchedulerRegistry } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
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
import { DiscordChatModule } from '../discord-chat/discord-chat.module';
import { WispaceModule } from '../wispace/wispace.module';
import { WispaceCalendarService } from '../wispace/application/services/wispace-calendar.service';
import { DiscordStudyReminderMessageSenderService } from '../discord-chat/application/services/discord-study-reminder-message-sender.service';
import { DiscordMappingReaderAdapter } from '../discord-chat/infrastructure/persistence/discord-mapping-reader.adapter';
import { DiscordRedisUserDisplayNameCache } from './discord-redis-user-display-name.cache';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      StudyReminderJobEntity,
      DiscordAccountLinkEntity,
    ]),
    DiscordChatModule,
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
      provide: DISPLAY_NAME_CACHE,
      useExisting: DiscordRedisUserDisplayNameCache,
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
          'discord',
          deps[5] && typeof deps[5] === 'object'
            ? (externalUserId: string) =>
                (deps[5] as WispaceCalendarService)
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
        { token: DataSource, optional: false },
        WispaceCalendarService,
      ],
    },
    DiscordRedisUserDisplayNameCache,
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
