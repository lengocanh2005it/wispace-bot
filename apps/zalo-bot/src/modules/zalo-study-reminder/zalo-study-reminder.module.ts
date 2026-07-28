import { Module } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  StudyReminderScheduleService,
  StudyReminderSyncService,
  StudyReminderDispatchService,
  StudyReminderWorkerService,
  MESSAGE_SENDER,
  MAPPING_READER,
  STUDY_REMINDER_JOB_REPOSITORY,
} from '@wispace/study-reminder-shared';
import { CleanupCronService } from '@wispace/cleanup-cron';
import { OpsHealthService, OPS_HEALTH_REPOSITORY } from '@wispace/ops-health';
import { StudyReminderJobEntity } from '../../infrastructure/database/entities/study-reminder-job.entity';
import { ZaloAccountLinkEntity } from '../../infrastructure/database/entities/zalo-account-link.entity';
import { ZaloOauthStateEntity } from '../../infrastructure/database/entities/zalo-oauth-state.entity';
import { ZaloChatModule } from '../zalo-chat/zalo-chat.module';
import { ZaloMessageSenderService } from '../zalo-chat/application/services/zalo-message-sender.service';
import { ZaloMappingReaderAdapter } from '../zalo-chat/infrastructure/persistence/zalo-mapping-reader.adapter';
import { ZaloStudyReminderJobRepository } from '../zalo-chat/infrastructure/persistence/zalo-study-reminder-job.repository';
import { ZaloCleanupCronService } from '../zalo-chat/application/services/zalo-cleanup-cron.service';
import { ZaloOpsHealthRepository } from '../zalo-chat/infrastructure/persistence/zalo-ops-health.repository';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      StudyReminderJobEntity,
      ZaloAccountLinkEntity,
      ZaloOauthStateEntity,
    ]),
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
          'zalo',
        ),
      inject: [
        StudyReminderSyncService,
        StudyReminderDispatchService,
        StudyReminderScheduleService,
        { token: SchedulerRegistry, optional: false },
        { token: DataSource, optional: false },
      ],
    },
    ZaloMessageSenderService,
    ZaloMappingReaderAdapter,
    ZaloStudyReminderJobRepository,
    CleanupCronService,
    ZaloCleanupCronService,
    {
      provide: OPS_HEALTH_REPOSITORY,
      useExisting: ZaloOpsHealthRepository,
    },
    ZaloOpsHealthRepository,
    OpsHealthService,
  ],
  exports: [
    StudyReminderSyncService,
    StudyReminderDispatchService,
    StudyReminderWorkerService,
  ],
})
export class ZaloStudyReminderModule {}
