import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  StudyReminderScheduleService,
  StudyReminderSyncService,
  StudyReminderDispatchService,
  StudyReminderWorkerService,
  MESSAGE_SENDER,
  MAPPING_READER,
  STUDY_REMINDER_JOB_REPOSITORY,
  DISPLAY_NAME_CACHE,
} from '@wispace/study-reminder-shared';
import { StudyReminderJobEntity } from '../../infrastructure/database/entities/study-reminder-job.entity';
import { DiscordAccountLinkEntity } from '../../infrastructure/database/entities/discord-account-link.entity';
import { DiscordChatModule } from '../discord-chat/discord-chat.module';
import { DiscordStudyReminderMessageSenderService } from '../discord-chat/application/services/discord-study-reminder-message-sender.service';
import { DiscordMappingReaderAdapter } from '../discord-chat/infrastructure/persistence/discord-mapping-reader.adapter';
import { DiscordStudyReminderJobRepository } from '../discord-chat/infrastructure/persistence/discord-study-reminder-job.repository';
import { DiscordRedisUserDisplayNameCache } from './discord-redis-user-display-name.cache';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      StudyReminderJobEntity,
      DiscordAccountLinkEntity,
    ]),
    DiscordChatModule,
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
      useExisting: DiscordStudyReminderJobRepository,
    },
    {
      provide: DISPLAY_NAME_CACHE,
      useExisting: DiscordRedisUserDisplayNameCache,
    },
    StudyReminderScheduleService,
    StudyReminderSyncService,
    StudyReminderDispatchService,
    StudyReminderWorkerService,
    DiscordRedisUserDisplayNameCache,
    DiscordStudyReminderMessageSenderService,
    DiscordMappingReaderAdapter,
    DiscordStudyReminderJobRepository,
  ],
  exports: [
    StudyReminderSyncService,
    StudyReminderDispatchService,
    StudyReminderWorkerService,
  ],
})
export class DiscordStudyReminderModule {}
