import { Module } from '@nestjs/common';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { DataSource, type Repository } from 'typeorm';
import {
  CleanupCronService,
  PlatformLinkAuditCleanupService,
} from '@wispace/cleanup-cron';
import { PgAdvisoryLockService } from '@wispace/bot-common/locks';
import {
  PlatformDeadLetterCronService,
  PlatformDeadLetterService,
  WebhookInboundEventEntity,
} from '@wispace/database';
import {
  PlatformWebhookInboundCleanupService,
  PlatformWebhookInboundEventService,
  PlatformWebhookInboundRetryCronService,
  InlineWebhookInboundDispatcher,
  readInboundRetryConfig,
  TRY_INLINE_DISPATCHER,
} from '@wispace/webhook-inbound';
import { WebhookDeadLetterEntity } from '../../infrastructure/database/entities';
import { DatabaseModule } from '../../infrastructure/database/database.module';
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
import { MessengerOutboundService } from './application/services/messenger-outbound.service';
import { MessengerReportModule } from './messenger-report.module';
import { MessengerController } from './presentation/controllers/messenger.controller';
import { validateAndMapMessengerEvent } from './presentation/mappers/messenger-webhook.mapper';
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
    DatabaseModule,
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
      provide: InlineWebhookInboundDispatcher,
      useFactory: (
        inboundEvents: PlatformWebhookInboundEventService,
        messengerService: MessengerService,
        configService: ConfigService,
      ) => {
        const retryConfig = readInboundRetryConfig((key) =>
          configService.get<string>(key),
        );
        return new InlineWebhookInboundDispatcher(inboundEvents, 'messenger', {
          processEvent: async (rawPayload) => {
            await messengerService.processEvent(
              await validateAndMapMessengerEvent(rawPayload),
            );
          },
          retryConfig,
        });
      },
      inject: [
        PlatformWebhookInboundEventService,
        MessengerService,
        ConfigService,
      ],
    },
    {
      provide: TRY_INLINE_DISPATCHER,
      useFactory:
        (dispatcher: InlineWebhookInboundDispatcher) =>
        (
          id: number,
          rawPayload: object,
          meta: { ingestedAt: Date; eventId: string; externalUserId: string },
        ) =>
          dispatcher.tryInline(id, rawPayload, meta),
      inject: [InlineWebhookInboundDispatcher],
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
              // Re-validate stored payloads before dispatch — replay must
              // never trust the persisted raw shape (#436).
              await messengerService.processEvent(
                await validateAndMapMessengerEvent(rawPayload),
              );
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
    {
      provide: PlatformLinkAuditCleanupService,
      useFactory: (
        cleanupCron: CleanupCronService,
        configService: ConfigService,
        dataSource: DataSource,
      ) =>
        new PlatformLinkAuditCleanupService(
          cleanupCron,
          configService,
          dataSource,
          { platform: 'messenger', advisoryLockId: 884_200_942 },
        ),
      inject: [CleanupCronService, ConfigService, DataSource],
    },
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
    {
      provide: PlatformDeadLetterCronService,
      useFactory: (
        deadLetterService: PlatformDeadLetterService,
        configService: ConfigService,
        outboundService: MessengerOutboundService,
        pgLock: PgAdvisoryLockService,
      ) =>
        new PlatformDeadLetterCronService(
          deadLetterService,
          configService,
          pgLock,
          {
            lockId: ADVISORY_LOCK.MESSENGER_DEAD_LETTER_RETRY,
            extractPayload: (payload) => ({
              externalUserId: payload.psid as string | undefined,
              text: payload.text as string | undefined,
            }),
            abandonReason: 'Missing psid or text in payload',
            retryAmbiguous: false,
            sendText: (externalUserId, text, opts) =>
              outboundService.sendTextForRetry(
                externalUserId,
                text,
                opts?.deliveryKey ?? '',
              ),
          },
        ),
      inject: [
        PlatformDeadLetterService,
        ConfigService,
        MessengerOutboundService,
        PgAdvisoryLockService,
      ],
    },
    MessengerReminderDeliveryService,
    WebhookActionExecutorService,
  ],
  exports: [MessengerOutboundModule, MessengerService, UserLinkingModule],
})
export class MessengerModule {}
