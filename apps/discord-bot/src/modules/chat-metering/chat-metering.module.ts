import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import {
  ChatDailyUsageEntity,
  ChatIdempotencyEntity,
  LlmSafetyEventEntity,
  LlmUsageEventEntity,
  LlmUsageConfigService,
  PlatformLlmUsageRecorderAdapter,
  PlatformLlmSafetyEventAdapter,
} from '@wispace/chat-metering';
import { Repository } from 'typeorm';
import { ChatRateLimitConfigService } from './application/services/chat-rate-limit-config.service';
import { DiscordChatRateLimitService } from './application/services/discord-chat-rate-limit.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ChatDailyUsageEntity,
      ChatIdempotencyEntity,
      LlmUsageEventEntity,
      LlmSafetyEventEntity,
    ]),
  ],
  providers: [
    ChatRateLimitConfigService,
    DiscordChatRateLimitService,
    LlmUsageConfigService,
    {
      provide: PlatformLlmUsageRecorderAdapter,
      useFactory: (
        configService: LlmUsageConfigService,
        usageRepo: Repository<LlmUsageEventEntity>,
      ) =>
        new PlatformLlmUsageRecorderAdapter(
          'discord',
          configService,
          usageRepo,
        ),
      inject: [LlmUsageConfigService, getRepositoryToken(LlmUsageEventEntity)],
    },
    {
      provide: PlatformLlmSafetyEventAdapter,
      useFactory: (
        safetyRepo: Repository<LlmSafetyEventEntity>,
        configService: ConfigService,
      ) =>
        new PlatformLlmSafetyEventAdapter('discord', safetyRepo, configService),
      inject: [getRepositoryToken(LlmSafetyEventEntity), ConfigService],
    },
  ],
  exports: [
    DiscordChatRateLimitService,
    PlatformLlmUsageRecorderAdapter,
    PlatformLlmSafetyEventAdapter,
  ],
})
export class ChatMeteringModule {}
