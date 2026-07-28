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
import { RedisWebhookDedupeStore } from './infrastructure/persistence/redis-webhook-dedupe.store';
import { WebhookDedupeStoreResolver } from './infrastructure/persistence/webhook-dedupe.store.resolver';
import { MessengerOutboundModule } from './messenger-outbound.module';
import { MessengerController } from './presentation/controllers/messenger.controller';
import { ChatPipelineModule } from './chat-pipeline.module';
import { UserLinkingModule } from './user-linking.module';
import { MessengerCalendarPort } from './infrastructure/adapters/messenger-calendar.port';
import { MessengerReschedulePort } from './infrastructure/adapters/messenger-reschedule.port';
import { MessengerRescheduleConfirmationService } from './application/services/messenger-reschedule-confirmation.service';

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
    RedisWebhookDedupeStore,
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
    MessengerRescheduleConfirmationService,
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
