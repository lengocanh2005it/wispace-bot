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
      useFactory: (
        syncService: StudyReminderSyncService,
        dispatchService: StudyReminderDispatchService,
        scheduleService: StudyReminderScheduleService,
        schedulerRegistry: SchedulerRegistry,
        dataSource: DataSource,
      ) =>
        new StudyReminderWorkerService(
          syncService,
          dispatchService,
          scheduleService,
          schedulerRegistry,
          dataSource,
          'zalo',
        ),
      inject: [
        StudyReminderSyncService,
        StudyReminderDispatchService,
        StudyReminderScheduleService,
        SchedulerRegistry,
        DataSource,
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
