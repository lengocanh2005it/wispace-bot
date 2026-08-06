import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import {
  ChatDailyUsageEntity,
  ChatIdempotencyEntity,
  LlmSafetyEventEntity,
  LlmUsageEventEntity,
  LlmUsageConfigService,
  PlatformChatRateLimitService,
  PlatformLlmUsageRecorderAdapter,
  PlatformLlmSafetyEventAdapter,
} from '@wispace/chat-metering';
import { Repository } from 'typeorm';

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
    LlmUsageConfigService,
    {
      provide: PlatformChatRateLimitService,
      useFactory: (
        configService: ConfigService,
        dailyUsageRepo: Repository<ChatDailyUsageEntity>,
        idempotencyRepo: Repository<ChatIdempotencyEntity>,
      ) =>
        new PlatformChatRateLimitService(
          { platform: 'discord', requireEnv: true, lenientEnabledCheck: true },
          configService,
          dailyUsageRepo,
          idempotencyRepo,
        ),
      inject: [
        ConfigService,
        getRepositoryToken(ChatDailyUsageEntity),
        getRepositoryToken(ChatIdempotencyEntity),
      ],
    },
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
    PlatformChatRateLimitService,
    PlatformLlmUsageRecorderAdapter,
    PlatformLlmSafetyEventAdapter,
  ],
})
export class ChatMeteringModule {}
