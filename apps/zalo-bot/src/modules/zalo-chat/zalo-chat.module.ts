import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createLlmProviderAdapter,
  type LlmProviderAdapter,
} from '@wispace/llm-agent';
import { ZaloOauthModule } from '../zalo-oauth/zalo-oauth.module';
import { ZaloAgentService } from './application/agent/zalo-agent.service';
import { ZaloAgentToolsService } from './application/agent/zalo-agent-tools.service';
import { ZaloChatHistoryService } from './application/services/zalo-chat-history.service';
import { ZaloOutboundService } from './application/services/zalo-outbound.service';
import { ZaloChatService } from './application/services/zalo-chat.service';

@Module({
  imports: [ZaloOauthModule],
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
    ZaloAgentService,
    ZaloAgentToolsService,
    ZaloChatHistoryService,
    ZaloOutboundService,
    ZaloChatService,
  ],
  exports: [ZaloChatService, ZaloOutboundService],
})
export class ZaloChatModule {}
