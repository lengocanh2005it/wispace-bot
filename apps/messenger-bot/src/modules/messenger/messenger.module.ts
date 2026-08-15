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
import { MessengerCalendarPort } from './infrastructure/adapters/messenger-calendar.port';
import { MessengerReschedulePort } from './infrastructure/adapters/messenger-reschedule.port';
import { ADVISORY_LOCK } from '../../shared/common/advisory-lock-ids';
import { MetricsService } from '../metrics/metrics.service';

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
      provide: PlatformWebhookInboundRetryCronService,
      useFactory: (
        inboundEvents: PlatformWebhookInboundEventService,
        configService: ConfigService,
        pgLock: PgAdvisoryLockService,
        messengerService: MessengerService,
        metrics: MetricsService,
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
              metrics.setWebhookInboundBacklog(stats.due),
          },
        ),
      inject: [
        PlatformWebhookInboundEventService,
        ConfigService,
        PgAdvisoryLockService,
        MessengerService,
        MetricsService,
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
    MessengerCalendarPort,
    MessengerReschedulePort,
    MessengerReminderDeliveryService,
    WebhookActionExecutorService,
  ],
  exports: [
    MessengerOutboundModule,
    MessengerService,
    MessengerCalendarPort,
    MessengerReschedulePort,
    UserLinkingModule,
  ],
})
export class MessengerModule {}
