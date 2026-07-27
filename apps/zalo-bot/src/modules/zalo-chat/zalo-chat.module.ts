import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  createLlmProviderAdapter,
  type LlmProviderAdapter,
} from '@wispace/llm-agent';
import {
  ChatDailyUsageEntity,
  ChatIdempotencyEntity,
  LlmUsageEventEntity,
  LlmSafetyEventEntity,
} from '@wispace/chat-metering';
import { ZaloOauthModule } from '../zalo-oauth/zalo-oauth.module';
import { ZaloAgentService } from './application/agent/zalo-agent.service';
import { ZaloAgentToolsService } from './application/agent/zalo-agent-tools.service';
import { ZaloChatHistoryService } from './application/services/zalo-chat-history.service';
import { ZaloOutboundService } from './application/services/zalo-outbound.service';
import { ZaloChatService } from './application/services/zalo-chat.service';
import { ZaloChatRateLimitService } from './application/services/zalo-chat-rate-limit.service';
import { ZaloLlmUsageConfigService } from './application/services/zalo-llm-usage-config.service';
import { ZaloLlmUsageRecorderService } from './application/services/zalo-llm-usage-recorder.service';
import { ZaloLlmSafetyEventService } from './application/services/zalo-llm-safety-event.service';

@Module({
  imports: [
    ZaloOauthModule,
    TypeOrmModule.forFeature([
      ChatDailyUsageEntity,
      ChatIdempotencyEntity,
      LlmUsageEventEntity,
      LlmSafetyEventEntity,
    ]),
  ],
  providers: [
    {
      provide: 'LLM_PROVIDER_ADAPTER',
      useFactory: (configService: ConfigService): LlmProviderAdapter =>
        createLlmProviderAdapter({
          getApiKey: () =>
            configService.get<string>('OPENAI_API_KEY')?.trim() || undefined,
          getModel: () =>
            configService.get<string>('OPENAI_MODEL')?.trim() || 'gpt-5.4',
          provider: 'openai',
        }),
      inject: [ConfigService],
    },
    ZaloLlmUsageConfigService,
    ZaloLlmUsageRecorderService,
    ZaloLlmSafetyEventService,
    ZaloAgentService,
    ZaloAgentToolsService,
    ZaloChatHistoryService,
    ZaloOutboundService,
    ZaloChatRateLimitService,
    ZaloChatService,
  ],
  exports: [ZaloChatService, ZaloOutboundService],
})
export class ZaloChatModule {}
