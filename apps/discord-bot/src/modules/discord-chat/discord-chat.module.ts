import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  createLlmProviderAdapter,
  createFailoverLlmProviderAdapter,
  type LlmProviderAdapter,
  type LlmProviderEntryConfig,
} from '@wispace/llm-agent';
import { CleanupCronService } from '@wispace/cleanup-cron';
import { OpsHealthService, OPS_HEALTH_REPOSITORY } from '@wispace/ops-health';
import { ChatMeteringModule } from '../chat-metering/chat-metering.module';
import { AccountLinkModule } from '../account-link/account-link.module';
import { WispaceModule } from '../wispace/wispace.module';
import { DiscordAgentService } from './application/agent/discord-agent.service';
import { DiscordAgentToolsService } from './application/agent/discord-agent-tools.service';
import { DiscordChatHistoryService } from './application/services/discord-chat-history.service';
import { DiscordRescheduleConfirmationService } from './application/services/discord-reschedule-confirmation.service';
import { DiscordMenuService } from './application/services/discord-menu.service';
import { DiscordDeadLetterService } from './application/services/discord-dead-letter.service';
import { DiscordDeadLetterCronService } from './application/services/discord-dead-letter-cron.service';
import { DiscordCleanupCronService } from './application/services/discord-cleanup-cron.service';
import { DiscordOutboundModule } from './discord-outbound.module';
import { DiscordReportModule } from './discord-report.module';
import { DiscordChatGateway } from './presentation/gateways/discord-chat.gateway';
import { WebhookDeadLetterEntity } from '../../infrastructure/database/entities/webhook-dead-letter.entity';
import { DiscordMessageLogEntity } from '../../infrastructure/database/entities/discord-message-log.entity';
import { DiscordOpsHealthRepository } from './infrastructure/persistence/discord-ops-health.repository';
import { ReportSendJobEntity } from '../../infrastructure/database/entities/report-send-job.entity';

@Module({
  imports: [
    ChatMeteringModule,
    DiscordOutboundModule,
    AccountLinkModule,
    WispaceModule,
    DiscordReportModule,
    TypeOrmModule.forFeature([
      WebhookDeadLetterEntity,
      DiscordMessageLogEntity,
      ReportSendJobEntity,
    ]),
  ],
  providers: [
    DiscordChatGateway,
    {
      provide: 'LLM_PROVIDER_ADAPTER',
      useFactory: (configService: ConfigService): LlmProviderAdapter => {
        const orderRaw = configService
          .get<string>('LLM_PROVIDER_FAILOVER_ORDER')
          ?.trim();
        const order = orderRaw
          ? orderRaw
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : [];

        if (order.length === 0) {
          return createLlmProviderAdapter({
            getApiKey: () =>
              configService.get<string>('OPENAI_API_KEY')?.trim() || undefined,
            getModel: () =>
              configService.get<string>('OPENAI_MODEL')?.trim() || 'gpt-5.4',
            provider: 'openai',
          });
        }

        const entries: LlmProviderEntryConfig[] = [
          {
            provider: 'openai',
            getApiKey: () =>
              configService.get<string>('OPENAI_API_KEY')?.trim() || undefined,
            getModel: () =>
              configService.get<string>('OPENAI_MODEL')?.trim() || 'gpt-5.4',
          },
          {
            provider: 'openrouter',
            getApiKey: () =>
              configService.get<string>('OPENROUTER_API_KEY')?.trim() ||
              undefined,
            getModel: () =>
              configService.get<string>('OPENROUTER_MODEL')?.trim() ||
              'openai/gpt-4o-mini',
            getBaseUrl: () =>
              configService.get<string>('OPENROUTER_BASE_URL')?.trim() ||
              'https://openrouter.ai/api/v1',
          },
          {
            provider: 'minimax',
            getApiKey: () =>
              configService.get<string>('MINIMAX_API_KEY')?.trim() || undefined,
            getModel: () =>
              configService.get<string>('MINIMAX_MODEL')?.trim() ||
              'MiniMax-Text-01',
            getBaseUrl: () =>
              configService.get<string>('MINIMAX_BASE_URL')?.trim() ||
              'https://api.minimax.chat/v1',
          },
        ];

        const readPositiveNumber = (key: string, fallback: number): number => {
          const raw = Number(configService.get(key));
          return Number.isFinite(raw) && raw > 0 ? raw : fallback;
        };

        return createFailoverLlmProviderAdapter(
          entries,
          order,
          {
            warn: (msg) => console.warn(msg),
          },
          {
            cooldownLongMs: readPositiveNumber(
              'LLM_FAILOVER_COOLDOWN_LONG_MS',
              600_000,
            ),
            cooldownShortMs: readPositiveNumber(
              'LLM_FAILOVER_COOLDOWN_SHORT_MS',
              5_000,
            ),
            quickRetryDelayMs: readPositiveNumber(
              'LLM_FAILOVER_QUICK_RETRY_DELAY_MS',
              150,
            ),
          },
        );
      },
      inject: [ConfigService],
    },
    DiscordAgentService,
    DiscordAgentToolsService,
    DiscordChatHistoryService,
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
})
export class DiscordChatModule {}
