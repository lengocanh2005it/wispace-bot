import { Module } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
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
import { OpsHealthService, OPS_HEALTH_REPOSITORY } from '@wispace/ops-health';
import { ZaloAccountLinkEntity } from '../../infrastructure/database/entities/zalo-account-link.entity';
import { ZaloOauthStateEntity } from '../../infrastructure/database/entities/zalo-oauth-state.entity';
import { ZaloChatModule } from '../zalo-chat/zalo-chat.module';
import { ZaloMessageSenderService } from '../zalo-chat/application/services/zalo-message-sender.service';
import { ZaloRedisUserDisplayNameCache } from './zalo-redis-user-display-name.cache';
import { ZaloMappingReaderAdapter } from '../zalo-chat/infrastructure/persistence/zalo-mapping-reader.adapter';
import { ZaloOpsHealthRepository } from '../zalo-chat/infrastructure/persistence/zalo-ops-health.repository';
import { ZaloWispaceModule } from '../wispace/zalo-wispace.module';
import { ZaloWispaceCalendarService } from '../wispace/application/services/zalo-wispace-calendar.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      StudyReminderJobEntity,
      ZaloAccountLinkEntity,
      ZaloOauthStateEntity,
    ]),
    ZaloChatModule,
    ZaloWispaceModule,
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
      useExisting: TypeormStudyReminderJobRepository,
    },
    {
      provide: DISPLAY_NAME_CACHE,
      useExisting: ZaloRedisUserDisplayNameCache,
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
          deps[5]
            ? (externalUserId: string) =>
                (deps[5] as ZaloWispaceCalendarService)
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
        ZaloWispaceCalendarService,
      ],
    },
    ZaloMessageSenderService,
    ZaloRedisUserDisplayNameCache,
    ZaloMappingReaderAdapter,
    TypeormStudyReminderJobRepository,
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
