import { Module } from '@nestjs/common';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import {
  MessageLogEntity,
  ScheduledReportClaimEntity,
  UserPlatformMappingEntity,
  WebhookDeadLetterEntity,
} from '../../infrastructure/database/entities';
import { PlatformDeadLetterService } from '@wispace/database';
import { MessengerOutboundService } from './application/services/messenger-outbound.service';
import { MESSENGER_REPOSITORY } from './domain/repositories/messenger.repository.port';
import { MESSENGER_MESSAGE_LOG_REPOSITORY } from './domain/repositories/messenger-message-log.repository.port';
import { REPORT_CLAIM_REPOSITORY } from '@wispace/scheduler-core';
import { MessengerRepository } from './infrastructure/persistence/messenger.repository';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      UserPlatformMappingEntity,
      MessageLogEntity,
      ScheduledReportClaimEntity,
      WebhookDeadLetterEntity,
    ]),
  ],
  providers: [
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
    MessengerOutboundService,
    PlatformDeadLetterService,
    MessengerRepository,
    MESSENGER_REPOSITORY,
    MESSENGER_MESSAGE_LOG_REPOSITORY,
    REPORT_CLAIM_REPOSITORY,
  ],
})
export class MessengerOutboundModule {}
