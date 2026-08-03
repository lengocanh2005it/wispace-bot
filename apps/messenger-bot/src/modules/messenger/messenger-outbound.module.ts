import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  MessageLogEntity,
  ScheduledReportClaimEntity,
  UserPlatformMappingEntity,
} from '../../infrastructure/database/entities';
import { MESSAGE_SENDER } from './application/ports/message-sender.port';
import { MessengerOutboundService } from './application/services/messenger-outbound.service';
import { MESSENGER_REPOSITORY } from './domain/repositories/messenger.repository.port';
import { MESSENGER_MAPPING_REPOSITORY } from './domain/repositories/messenger-mapping.repository.port';
import { MESSENGER_MESSAGE_LOG_REPOSITORY } from './domain/repositories/messenger-message-log.repository.port';
import { REPORT_CLAIM_REPOSITORY } from '@wispace/scheduler-core';
import { MESSENGER_MAPPING_READER } from '../../shared/ports/messenger-mapping-reader.port';
import { MessengerRepository } from './infrastructure/persistence/messenger.repository';
import { MessengerMappingReaderAdapter } from './infrastructure/persistence/messenger-mapping-reader.adapter';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      UserPlatformMappingEntity,
      MessageLogEntity,
      ScheduledReportClaimEntity,
    ]),
  ],
  providers: [
    MessengerRepository,
    MessengerOutboundService,
    MessengerMappingReaderAdapter,
    {
      provide: MESSENGER_REPOSITORY,
      useExisting: MessengerRepository,
    },
    {
      provide: MESSENGER_MAPPING_REPOSITORY,
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
    {
      provide: MESSENGER_MAPPING_READER,
      useExisting: MessengerMappingReaderAdapter,
    },
    {
      provide: MESSAGE_SENDER,
      useExisting: MessengerOutboundService,
    },
  ],
  exports: [
    MessengerOutboundService,
    MessengerRepository,
    MESSENGER_REPOSITORY,
    MESSENGER_MAPPING_REPOSITORY,
    MESSENGER_MESSAGE_LOG_REPOSITORY,
    REPORT_CLAIM_REPOSITORY,
    MESSENGER_MAPPING_READER,
    MESSAGE_SENDER,
  ],
})
export class MessengerOutboundModule {}
