import { Module } from '@nestjs/common';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import {
  MessageLogEntity,
  ScheduledReportClaimEntity,
  LearnerScheduledReportClaimEntity,
  UserPlatformMappingEntity,
  WebhookDeadLetterEntity,
} from '../../infrastructure/database/entities';
import { PlatformDeadLetterService } from '@wispace/database';
import { MessengerOutboundService } from './application/services/messenger-outbound.service';
import { MESSENGER_REPOSITORY } from './domain/repositories/messenger.repository.port';
import { MESSENGER_MESSAGE_LOG_REPOSITORY } from './domain/repositories/messenger-message-log.repository.port';
import { REPORT_CLAIM_REPOSITORY } from '@wispace/scheduler-core';
import { MessengerRepository } from './infrastructure/persistence/messenger.repository';
import {
  PLATFORM_CONNECTIVITY,
  PlatformConnectivityState,
} from '@wispace/bot-common/health';
import { BotMetricsService } from '@wispace/bot-metrics';
import { MessengerPlatformConnectivityService } from './infrastructure/meta/messenger-platform-connectivity.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      UserPlatformMappingEntity,
      MessageLogEntity,
      ScheduledReportClaimEntity,
      LearnerScheduledReportClaimEntity,
      WebhookDeadLetterEntity,
    ]),
  ],
  providers: [
    {
      provide: PlatformConnectivityState,
      useFactory: (metrics: BotMetricsService) =>
        new PlatformConnectivityState('messenger', ({ previous, current }) =>
          metrics.setPlatformConnectivity(previous, current),
        ),
      inject: [BotMetricsService],
    },
    {
      provide: PLATFORM_CONNECTIVITY,
      useExisting: PlatformConnectivityState,
    },
    MessengerPlatformConnectivityService,
    MessengerRepository,
    MessengerOutboundService,
    {
      provide: PlatformDeadLetterService,
      useFactory: (repo: Repository<WebhookDeadLetterEntity>) =>
        new PlatformDeadLetterService('messenger', repo),
      inject: [getRepositoryToken(WebhookDeadLetterEntity)],
    },
    {
      provide: MESSENGER_REPOSITORY,
      useExisting: MessengerRepository,
    },
    {
      provide: MESSENGER_MESSAGE_LOG_REPOSITORY,
      useExisting: MessengerRepository,
    },
    {
      provide: REPORT_CLAIM_REPOSITORY,
      useExisting: MessengerRepository,
    },
  ],
  exports: [
    PLATFORM_CONNECTIVITY,
    PlatformConnectivityState,
    MessengerPlatformConnectivityService,
    MessengerOutboundService,
    PlatformDeadLetterService,
    MessengerRepository,
    MESSENGER_REPOSITORY,
    MESSENGER_MESSAGE_LOG_REPOSITORY,
    REPORT_CLAIM_REPOSITORY,
  ],
})
export class MessengerOutboundModule {}
