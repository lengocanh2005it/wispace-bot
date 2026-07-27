import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommonModule } from '../../shared/common/common.module';
import {
  ChatDailyUsageEntity,
  ChatIdempotencyEntity,
  MemoryBurstCounter,
  PostgresBurstCounter,
} from '@wispace/chat-metering';
import { CleanupCronService } from '@wispace/cleanup-cron';
import { ChatQuotaEventEntity } from '../../infrastructure/database/entities/chat-quota-event.entity';
import { ChatQuotaEventCleanupCronService } from './application/services/chat-quota-event-cleanup-cron.service';
import { ChatQuotaEventCleanupService } from './application/services/chat-quota-event-cleanup.service';
import { ChatQuotaEventRecorderService } from './application/services/chat-quota-event-recorder.service';
import { ChatRateLimitConfigService } from './application/services/chat-rate-limit-config.service';
import { ChatRateLimitStartupService } from './application/services/chat-rate-limit-startup.service';
import { ChatRateLimitService } from './application/services/chat-rate-limit.service';
import { ChatQuotaOpsService } from './application/services/chat-quota-ops.service';
import { CHAT_BURST_COUNTER } from './domain/repositories/chat-burst-counter.port';
import type { ChatBurstCounterPort } from './domain/repositories/chat-burst-counter.port';
import { CHAT_QUOTA_EVENT_REPOSITORY } from './domain/repositories/chat-quota-event.repository.port';
import { CHAT_QUOTA_REPOSITORY } from './domain/repositories/chat-quota.repository.port';
import { ChatQuotaEventRepository } from './infrastructure/persistence/chat-quota-event.repository';
import { RedisChatBurstCounter } from './infrastructure/persistence/redis-chat-burst-counter';
import { ChatRateLimitRepository } from './infrastructure/persistence/chat-rate-limit.repository';
import { RedisConfigService } from '../../infrastructure/redis/application/services/redis-config.service';
import { Logger } from '@nestjs/common';

@Module({
  imports: [
    CommonModule,
    TypeOrmModule.forFeature([
      ChatDailyUsageEntity,
      ChatIdempotencyEntity,
      ChatQuotaEventEntity,
    ]),
  ],
  providers: [
    ChatRateLimitConfigService,
    ChatRateLimitStartupService,
    RedisChatBurstCounter,
    {
      provide: CHAT_BURST_COUNTER,
      useFactory: (
        config: ChatRateLimitConfigService,
        redisCounter: RedisChatBurstCounter,
        redisConfig: RedisConfigService,
        repository: ChatRateLimitRepository,
      ): ChatBurstCounterPort => {
        const logger = new Logger('ChatBurstCounter');
        const configured = config.getBurstStore();

        if (configured === 'redis' && redisCounter.isAvailable()) {
          logger.log(
            `Chat burst counter active=redis configured=redis limit=${config.getBurstPerMinute()}/min`,
          );
          return redisCounter;
        }

        if (configured === 'redis') {
          logger.warn(
            'CHAT_BURST_STORE=redis but Redis client unavailable — using postgres fallback',
          );
        }

        if (configured === 'memory') {
          logger.log(
            `Chat burst counter active=memory configured=memory limit=${config.getBurstPerMinute()}/min`,
          );
          return new MemoryBurstCounter();
        }

        logger.log(
          `Chat burst counter active=postgres configured=${configured} limit=${config.getBurstPerMinute()}/min`,
        );
        return new PostgresBurstCounter(
          {
            countRecentReservations: (psid, since, options) =>
              repository.countRecentReservations(psid, since, options),
          },
          config.getBurstCountsRefunded(),
        );
      },
      inject: [
        ChatRateLimitConfigService,
        RedisChatBurstCounter,
        RedisConfigService,
        ChatRateLimitRepository,
      ],
    },
    ChatQuotaEventRepository,
    {
      provide: CHAT_QUOTA_EVENT_REPOSITORY,
      useExisting: ChatQuotaEventRepository,
    },
    ChatQuotaEventRecorderService,
    ChatQuotaEventCleanupService,
    CleanupCronService,
    ChatQuotaEventCleanupCronService,
    ChatRateLimitService,
    ChatQuotaOpsService,
    ChatRateLimitRepository,
    {
      provide: CHAT_QUOTA_REPOSITORY,
      useExisting: ChatRateLimitRepository,
    },
  ],
  exports: [
    ChatRateLimitConfigService,
    ChatRateLimitService,
    ChatQuotaOpsService,
    CHAT_QUOTA_REPOSITORY,
  ],
})
export class ChatRateLimitModule {}
