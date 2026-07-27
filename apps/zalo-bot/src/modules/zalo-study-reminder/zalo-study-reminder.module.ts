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
} from '@wispace/study-reminder-shared';
import { StudyReminderJobEntity } from '../../infrastructure/database/entities/study-reminder-job.entity';
import { ZaloAccountLinkEntity } from '../../infrastructure/database/entities/zalo-account-link.entity';
import { ZaloChatModule } from '../zalo-chat/zalo-chat.module';
import { ZaloMessageSenderService } from '../zalo-chat/application/services/zalo-message-sender.service';
import { ZaloMappingReaderAdapter } from '../zalo-chat/infrastructure/persistence/zalo-mapping-reader.adapter';
import { ZaloStudyReminderJobRepository } from '../zalo-chat/infrastructure/persistence/zalo-study-reminder-job.repository';

@Module({
  imports: [
    TypeOrmModule.forFeature([StudyReminderJobEntity, ZaloAccountLinkEntity]),
    ZaloChatModule,
  ],
  providers: [
    {
      provide: MESSAGE_SENDER,
      useExisting: ZaloMessageSenderService,
    },
    {
      provide: MAPPING_READER,
      useExisting: ZaloMappingReaderAdapter,
    },
    {
      provide: STUDY_REMINDER_JOB_REPOSITORY,
      useExisting: ZaloStudyReminderJobRepository,
    },
    StudyReminderScheduleService,
    StudyReminderSyncService,
    StudyReminderDispatchService,
    StudyReminderWorkerService,
    ZaloMessageSenderService,
    ZaloMappingReaderAdapter,
    ZaloStudyReminderJobRepository,
  ],
  exports: [
    StudyReminderSyncService,
    StudyReminderDispatchService,
    StudyReminderWorkerService,
  ],
})
export class ZaloStudyReminderModule {}
