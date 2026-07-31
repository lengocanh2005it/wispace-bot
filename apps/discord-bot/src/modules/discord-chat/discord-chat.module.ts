import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CleanupCronService } from '@wispace/cleanup-cron';
import { OpsHealthService, OPS_HEALTH_REPOSITORY } from '@wispace/ops-health';
import { ChatMeteringModule } from '../chat-metering/chat-metering.module';
import { AccountLinkModule } from '../account-link/account-link.module';
import { WispaceModule } from '../wispace/wispace.module';
import { DiscordAgentService } from './application/agent/discord-agent.service';
import { DiscordAgentToolsService } from './application/agent/discord-agent-tools.service';
import { DiscordChatHistoryService } from './application/services/discord-chat-history.service';
import { DiscordChatQueueService } from './application/services/discord-chat-queue.service';
import { DiscordRescheduleConfirmationService } from './application/services/discord-reschedule-confirmation.service';
import { DiscordMenuService } from './application/services/discord-menu.service';
import { DiscordDeadLetterService } from './application/services/discord-dead-letter.service';
import { DiscordDeadLetterCronService } from './application/services/discord-dead-letter-cron.service';
import { DiscordCleanupCronService } from './application/services/discord-cleanup-cron.service';
import { DiscordOutboundModule } from './discord-outbound.module';
import { DiscordSharedModule } from './discord-shared.module';
import { DiscordChatGateway } from './presentation/gateways/discord-chat.gateway';
import { WebhookDeadLetterEntity } from '../../infrastructure/database/entities/webhook-dead-letter.entity';
import { DiscordMessageLogEntity } from '../../infrastructure/database/entities/discord-message-log.entity';
import { DiscordOpsHealthRepository } from './infrastructure/persistence/discord-ops-health.repository';
import { ReportSendJobEntity } from '../../infrastructure/database/entities/report-send-job.entity';
import { ChatIdempotencyEntity } from '@wispace/chat-metering';
import { DiscordCalendarPort } from './infrastructure/adapters/discord-calendar.port';
import { DiscordReschedulePort } from './infrastructure/adapters/discord-reschedule.port';

@Module({
  imports: [
    ChatMeteringModule,
    DiscordOutboundModule,
    DiscordSharedModule,
    AccountLinkModule,
    WispaceModule,
    TypeOrmModule.forFeature([
      WebhookDeadLetterEntity,
      DiscordMessageLogEntity,
      ReportSendJobEntity,
      ChatIdempotencyEntity,
    ]),
  ],
  providers: [
    DiscordChatGateway,
    DiscordAgentService,
    DiscordAgentToolsService,
    DiscordChatHistoryService,
    DiscordChatQueueService,
    DiscordCalendarPort,
    DiscordReschedulePort,
    DiscordRescheduleConfirmationService,
    DiscordMenuService,
    DiscordDeadLetterService,
    DiscordDeadLetterCronService,
    CleanupCronService,
    DiscordCleanupCronService,
    {
      provide: OPS_HEALTH_REPOSITORY,
      useExisting: DiscordOpsHealthRepository,
    },
    DiscordOpsHealthRepository,
    OpsHealthService,
  ],
  exports: ['LLM_PROVIDER_ADAPTER'],
})
export class DiscordChatModule {}
