import { Module } from '@nestjs/common';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';
import { CleanupCronService } from '@wispace/cleanup-cron';
import { PgAdvisoryLockService } from '@wispace/bot-common';
import {
  PlatformWebhookInboundCleanupService,
  PlatformWebhookInboundEventService,
  PlatformWebhookInboundRetryCronService,
  WebhookInboundEventEntity,
} from '@wispace/database';
import { WebhookDeadLetterEntity } from '../../infrastructure/database/entities';
import { CommonModule } from '../../shared/common/common.module';
import { ChatRateLimitModule } from '../chat-rate-limit/chat-rate-limit.module';
import { StudentReportModule } from '../student-report/student-report.module';
import { StudyReminderModule } from '../study-reminder/study-reminder.module';
import { DisplayNameModule } from '../display-name/display-name.module';
import { MessengerMessageLogCleanupService } from './application/services/messenger-message-log-cleanup.service';
import { MessengerWebhookStartupService } from './application/services/messenger-webhook-startup.service';
import { MessengerReminderDeliveryService } from './application/services/messenger-reminder-delivery.service';
import { WebhookActionExecutorService } from './application/services/webhook-action-executor.service';
import { MessengerService } from './application/services/messenger.service';
import { MessengerProfileService } from './infrastructure/meta/messenger-profile.service';
import { MessengerOutboundModule } from './messenger-outbound.module';
import { MessengerReportModule } from './messenger-report.module';
import { MessengerController } from './presentation/controllers/messenger.controller';
import { ChatPipelineModule } from './chat-pipeline.module';
import { UserLinkingModule } from './user-linking.module';
import { WEBHOOK_INBOUND_EVENTS_PORT } from './domain/repositories/webhook-inbound-events.port';
import type { WebhookInboundEventsPort } from './domain/repositories/webhook-inbound-events.port';
import { ADVISORY_LOCK } from '../../shared/common/advisory-lock-ids';
import { BotMetricsService } from '@wispace/bot-metrics';

/**
 * Thin orchestrator module — owns webhook handling, event routing,
 * report/reminder delivery, and message log cleanup.
 *
 * Chat pipeline and user linking are extracted to their own modules.
 */
@Module({
  imports: [
    CommonModule,
    MessengerOutboundModule,
    ChatRateLimitModule,
    StudentReportModule,
    StudyReminderModule,
    DisplayNameModule,
    ChatPipelineModule,
    UserLinkingModule,
    MessengerReportModule,
    TypeOrmModule.forFeature([
      WebhookDeadLetterEntity,
      WebhookInboundEventEntity,
    ]),
  ],
  controllers: [MessengerController],
  providers: [
    MessengerService,
    MessengerProfileService,
    MessengerWebhookStartupService,
    {
      provide: PlatformWebhookInboundEventService,
      useFactory: (repo: Repository<WebhookInboundEventEntity>) =>
        new PlatformWebhookInboundEventService('messenger', repo),
      inject: [getRepositoryToken(WebhookInboundEventEntity)],
    },
    {
      provide: WEBHOOK_INBOUND_EVENTS_PORT,
      useFactory: (
        inboundEvents: PlatformWebhookInboundEventService,
      ): WebhookInboundEventsPort => ({
        ingest: (input) => inboundEvents.ingest(input),
      }),
      inject: [PlatformWebhookInboundEventService],
    },
    {
      provide: PlatformWebhookInboundRetryCronService,
      useFactory: (
        inboundEvents: PlatformWebhookInboundEventService,
        configService: ConfigService,
        pgLock: PgAdvisoryLockService,
        messengerService: MessengerService,
        metrics: BotMetricsService,
      ) =>
        new PlatformWebhookInboundRetryCronService(
          inboundEvents,
          configService,
          pgLock,
          {
            lockId: ADVISORY_LOCK.MESSENGER_WEBHOOK_INBOUND_RETRY,
            processEvent: async (rawPayload) => {
              await messengerService.processEvent(rawPayload);
            },
            onTickComplete: (stats) =>
              metrics.setWebhookInboundBacklog(stats.backlog),
          },
        ),
      inject: [
        PlatformWebhookInboundEventService,
        ConfigService,
        PgAdvisoryLockService,
        MessengerService,
        BotMetricsService,
      ],
    },
    CleanupCronService,
    MessengerMessageLogCleanupService,
    {
      provide: PlatformWebhookInboundCleanupService,
      useFactory: (
        inboundEvents: PlatformWebhookInboundEventService,
        configService: ConfigService,
        pgLock: PgAdvisoryLockService,
      ) =>
        new PlatformWebhookInboundCleanupService(
          inboundEvents,
          configService,
          pgLock,
          { lockId: ADVISORY_LOCK.MESSENGER_WEBHOOK_INBOUND_CLEANUP },
        ),
      inject: [
        PlatformWebhookInboundEventService,
        ConfigService,
        PgAdvisoryLockService,
      ],
    },
    MessengerReminderDeliveryService,
    WebhookActionExecutorService,
  ],
  exports: [MessengerOutboundModule, MessengerService, UserLinkingModule],
})
export class MessengerModule {}
