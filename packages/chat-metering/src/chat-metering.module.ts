import { Module, type DynamicModule } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import {
  ChatDailyUsageEntity,
  ChatIdempotencyEntity,
  LlmSafetyEventEntity,
  LlmUsageEventEntity,
} from './entities';
import {
  PlatformChatRateLimitService,
  type PlatformChatRateLimitOptions,
} from './chat-rate-limit/platform-chat-rate-limit.service';
import { LlmUsageConfigService } from './llm-usage/llm-usage-config.service';
import { PlatformLlmUsageRecorderAdapter } from './llm-usage/platform-llm-usage-recorder.adapter';
import { PlatformLlmSafetyEventAdapter } from './llm-safety/platform-llm-safety-event.adapter';

/**
 * Shared NestJS wiring for chat quota/rate-limit + LLM usage/safety tracking —
 * replaces the near-identical `ChatMeteringModule` blocks in the Discord and
 * Zalo app modules. `forPlatform` parameterizes the platform row key and the
 * strict/lenient config flags (`requireEnv`/`lenientEnabledCheck` — discord).
 */
@Module({})
export class ChatMeteringModule {
  static forPlatform(
    platform: string,
    options?: { requireEnv?: boolean; lenientEnabledCheck?: boolean },
  ): DynamicModule {
    const rateLimitOptions: PlatformChatRateLimitOptions = { platform };
    if (options?.requireEnv !== undefined) {
      rateLimitOptions.requireEnv = options.requireEnv;
    }
    if (options?.lenientEnabledCheck !== undefined) {
      rateLimitOptions.lenientEnabledCheck = options.lenientEnabledCheck;
    }

    return {
      module: ChatMeteringModule,
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
              rateLimitOptions,
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
              platform,
              configService,
              usageRepo,
            ),
          inject: [
            LlmUsageConfigService,
            getRepositoryToken(LlmUsageEventEntity),
          ],
        },
        {
          provide: PlatformLlmSafetyEventAdapter,
          useFactory: (
            safetyRepo: Repository<LlmSafetyEventEntity>,
            configService: ConfigService,
          ) =>
            new PlatformLlmSafetyEventAdapter(
              platform,
              safetyRepo,
              configService,
            ),
          inject: [getRepositoryToken(LlmSafetyEventEntity), ConfigService],
        },
      ],
      exports: [
        PlatformChatRateLimitService,
        PlatformLlmUsageRecorderAdapter,
        PlatformLlmSafetyEventAdapter,
      ],
    };
  }
}
