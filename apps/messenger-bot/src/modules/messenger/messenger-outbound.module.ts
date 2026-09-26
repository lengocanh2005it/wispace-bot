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
import {
  OUTBOUND_DEAD_LETTER,
  type OutboundDeadLetterPort,
} from '@wispace/contracts';
import { PlatformReportClaimRepository } from '@wispace/scheduler-core/adapters';
import { MessengerOutboundService } from './application/services/messenger-outbound.service';
import { MESSENGER_REPOSITORY } from './domain/repositories/messenger.repository.port';
import { MESSENGER_MESSAGE_LOG_REPOSITORY } from './domain/repositories/messenger-message-log.repository.port';
import { REPORT_CLAIM_REPOSITORY } from '@wispace/scheduler-core/core';
import type { ReportClaimRepositoryPort } from '@wispace/scheduler-core/core';
import { MessengerRepository } from './infrastructure/persistence/messenger.repository';
import { MessengerReportSentReader } from './infrastructure/persistence/messenger-report-sent-reader';
import { MESSENGER_REPORT_SENT_READER } from './domain/repositories/messenger-report-sent-reader.port';
import {
  PLATFORM_CONNECTIVITY,
  PlatformConnectivityState,
} from '@wispace/bot-common/health';
import { BotMetricsService } from '@wispace/bot-metrics';
import { MessengerPlatformConnectivityService } from './infrastructure/meta/messenger-platform-connectivity.service';
import { MessengerConnectivitySignalAdapter } from './infrastructure/meta/connectivity-signal.adapter';
import { PLATFORM_CONNECTIVITY_SIGNAL } from './application/ports/platform-connectivity-signal.port';

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
    MessengerConnectivitySignalAdapter,
    {
      provide: PLATFORM_CONNECTIVITY_SIGNAL,
      useExisting: MessengerConnectivitySignalAdapter,
    },
    MessengerRepository,
    MessengerReportSentReader,
    MessengerOutboundService,
    {
      provide: PlatformDeadLetterService,
      useFactory: (repo: Repository<WebhookDeadLetterEntity>) =>
        new PlatformDeadLetterService('messenger', repo),
      inject: [getRepositoryToken(WebhookDeadLetterEntity)],
    },
    {
      provide: OUTBOUND_DEAD_LETTER,
      useFactory: (
        deadLetter: PlatformDeadLetterService,
      ): OutboundDeadLetterPort => ({
        saveDeadLetter: (input) => deadLetter.save(input),
      }),
      inject: [PlatformDeadLetterService],
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
      useFactory: (
        repo: Repository<ScheduledReportClaimEntity>,
        learnerRepo: Repository<LearnerScheduledReportClaimEntity>,
      ): ReportClaimRepositoryPort =>
        new PlatformReportClaimRepository('messenger', repo, learnerRepo),
      inject: [
        getRepositoryToken(ScheduledReportClaimEntity),
        getRepositoryToken(LearnerScheduledReportClaimEntity),
      ],
    },
    {
      provide: MESSENGER_REPORT_SENT_READER,
      useExisting: MessengerReportSentReader,
    },
  ],
  exports: [
    PLATFORM_CONNECTIVITY,
    PlatformConnectivityState,
    MessengerPlatformConnectivityService,
    MessengerOutboundService,
    PlatformDeadLetterService,
    OUTBOUND_DEAD_LETTER,
    MessengerRepository,
    MESSENGER_REPOSITORY,
    MESSENGER_MESSAGE_LOG_REPOSITORY,
    REPORT_CLAIM_REPOSITORY,
    MESSENGER_REPORT_SENT_READER,
  ],
})
export class MessengerOutboundModule {}
