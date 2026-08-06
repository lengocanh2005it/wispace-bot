import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { PgAdvisoryLockService } from '@wispace/bot-common';
import {
  StudyReminderScheduleService,
  StudyReminderSyncService,
  StudyReminderDispatchService,
  StudyReminderWorkerService,
  StudyReminderJobEntity,
  TypeormStudyReminderJobRepository,
  TypeormMappingReader,
  wrapMessageSender,
  MESSAGE_SENDER,
  MAPPING_READER,
  STUDY_REMINDER_JOB_REPOSITORY,
  DISPLAY_NAME_CACHE,
} from '@wispace/study-reminder-shared';
import { OpsHealthService, OPS_HEALTH_REPOSITORY } from '@wispace/ops-health';
import { TypeormOpsHealthRepository } from '@wispace/ops-health';
import { ZaloAccountLinkEntity } from '../../infrastructure/database/entities/zalo-account-link.entity';
import { ZaloOauthStateEntity } from '../../infrastructure/database/entities/zalo-oauth-state.entity';
import { BotCommonModule } from '@wispace/bot-common';
import { ZaloChatModule } from '../zalo-chat/zalo-chat.module';
import { ZaloOutboundService } from '../zalo-chat/application/services/zalo-outbound.service';
import {
  REDIS_CLIENT,
  RedisUserDisplayNameCache,
  type RedisClientPort,
} from '@wispace/bot-common';
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
  providers: [
    {
      provide: MESSAGE_SENDER,
      useFactory: (outbound: ZaloOutboundService) =>
        wrapMessageSender(outbound),
      inject: [ZaloOutboundService],
    },
    {
      provide: MAPPING_READER,
      useFactory: (repo: Repository<ZaloAccountLinkEntity>) =>
        new TypeormMappingReader(repo, 'zalo_account_links'),
      inject: [getRepositoryToken(ZaloAccountLinkEntity)],
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
          platform: 'zalo',
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
          'zalo',
          deps[6]
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
    TypeormStudyReminderJobRepository,
    {
      provide: OPS_HEALTH_REPOSITORY,
      useFactory: (dataSource: DataSource) =>
        new TypeormOpsHealthRepository(dataSource, 'zalo'),
      inject: [DataSource],
    },
    OpsHealthService,
  ],
  exports: [
    StudyReminderSyncService,
    StudyReminderDispatchService,
    StudyReminderWorkerService,
  ],
})
export class ZaloStudyReminderModule {}
