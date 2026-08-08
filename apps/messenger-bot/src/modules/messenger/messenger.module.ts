import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CleanupCronService } from '@wispace/cleanup-cron';
import { WebhookDeadLetterEntity } from '../../infrastructure/database/entities';
import { MESSENGER_WEBHOOK_DEAD_LETTER_REPOSITORY } from './domain/repositories/messenger-webhook-dead-letter.repository.port';
import { MessengerWebhookDeadLetterRepository } from './infrastructure/persistence/messenger-webhook-dead-letter.repository';
import { CommonModule } from '../../shared/common/common.module';
import { ChatRateLimitModule } from '../chat-rate-limit/chat-rate-limit.module';
import { StudentReportModule } from '../student-report/student-report.module';
import { StudyReminderModule } from '../study-reminder/study-reminder.module';
import { DisplayNameModule } from '../display-name/display-name.module';
import { WebhookDedupeStoreStartupService } from './application/services/webhook-dedupe-store-startup.service';
import { MessengerMessageLogCleanupService } from './application/services/messenger-message-log-cleanup.service';
import { MessengerWebhookDeadLetterCronService } from './application/services/messenger-webhook-dead-letter-cron.service';
import { MessengerWebhookStartupService } from './application/services/messenger-webhook-startup.service';
import { MessengerReportDeliveryService } from './application/services/messenger-report-delivery.service';
import { MessengerReminderDeliveryService } from './application/services/messenger-reminder-delivery.service';
import { WebhookActionExecutorService } from './application/services/webhook-action-executor.service';
import { MessengerService } from './application/services/messenger.service';
import { MessengerProfileService } from './infrastructure/meta/messenger-profile.service';
import { WEBHOOK_DEDUPE_STORE } from './domain/repositories/webhook-dedupe.store.port';
import { MemoryWebhookDedupeStore } from './infrastructure/persistence/memory-webhook-dedupe.store';
import { WebhookDedupeStoreResolver } from './infrastructure/persistence/webhook-dedupe.store.resolver';
import {
  REDIS_CLIENT,
  RedisWebhookDedupeStore,
  type RedisClientPort,
} from '@wispace/bot-common';
import { MessengerChatSharedConfigService } from './application/services/messenger-chat-shared-config.service';
import { WEBHOOK_POSTBACK_DEDUPE_MS } from './domain/entities/messenger-store.types';
import { MessengerOutboundModule } from './messenger-outbound.module';
import { MessengerController } from './presentation/controllers/messenger.controller';
import { ChatPipelineModule } from './chat-pipeline.module';
import { UserLinkingModule } from './user-linking.module';
import { MessengerCalendarPort } from './infrastructure/adapters/messenger-calendar.port';
import { MessengerReschedulePort } from './infrastructure/adapters/messenger-reschedule.port';

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
    TypeOrmModule.forFeature([WebhookDeadLetterEntity]),
  ],
  controllers: [MessengerController],
  providers: [
    MessengerService,
    MessengerProfileService,
    MessengerWebhookStartupService,
    MemoryWebhookDedupeStore,
    {
      provide: RedisWebhookDedupeStore,
      useFactory: (
        redisClient: RedisClientPort,
        sharedConfig: MessengerChatSharedConfigService,
      ) =>
        new RedisWebhookDedupeStore(redisClient, {
          platform: 'messenger',
          midTtlSeconds: () =>
            Math.max(
              1,
              Math.ceil(sharedConfig.getWebhookDedupeRetentionMs() / 1000),
            ),
          postbackTtlSeconds: () =>
            Math.max(1, Math.ceil(WEBHOOK_POSTBACK_DEDUPE_MS / 1000)),
        }),
      inject: [REDIS_CLIENT, MessengerChatSharedConfigService],
    },
    WebhookDedupeStoreResolver,
    WebhookDedupeStoreStartupService,
    {
      provide: WEBHOOK_DEDUPE_STORE,
      useExisting: WebhookDedupeStoreResolver,
    },
    MessengerWebhookDeadLetterRepository,
    {
      provide: MESSENGER_WEBHOOK_DEAD_LETTER_REPOSITORY,
      useExisting: MessengerWebhookDeadLetterRepository,
    },
    CleanupCronService,
    MessengerWebhookDeadLetterCronService,
    MessengerMessageLogCleanupService,
    MessengerCalendarPort,
    MessengerReschedulePort,
    MessengerReportDeliveryService,
    MessengerReminderDeliveryService,
    WebhookActionExecutorService,
  ],
  exports: [
    MessengerOutboundModule,
    MessengerService,
    MessengerReportDeliveryService,
    MessengerCalendarPort,
    MessengerReschedulePort,
    UserLinkingModule,
  ],
})
export class MessengerModule {}
