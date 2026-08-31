import { Module, Logger } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { REDIS_CLIENT, type RedisClientPort } from '@wispace/bot-common/redis';
import { CommonModule } from '../../shared/common/common.module';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BotMetricsService } from '@wispace/bot-metrics';
import {
  ChatDailyUsageEntity,
  ChatIdempotencyEntity,
  ChatToolDailyUsageEntity,
  PlatformWriteToolBudgetService,
  MemoryBurstCounter,
  PostgresBurstCounter,
  RedisBurstCounter,
  type BurstReservationResult,
} from '@wispace/chat-metering';
import { CleanupCronService } from '@wispace/cleanup-cron';
import { ChatQuotaEventEntity } from '../../infrastructure/database/entities/chat-quota-event.entity';
import { ChatQuotaEventCleanupCronService } from './application/services/chat-quota-event-cleanup-cron.service';
import { ChatQuotaEventRecorderService } from './application/services/chat-quota-event-recorder.service';
import { ChatQuotaStuckRecoveryCronService } from './application/services/chat-quota-stuck-recovery-cron.service';
import { ChatIdempotencyCleanupCronService } from './application/services/chat-idempotency-cleanup-cron.service';
import { ChatRateLimitConfigService } from './application/services/chat-rate-limit-config.service';
import { ChatRateLimitStartupService } from './application/services/chat-rate-limit-startup.service';
import { ChatRateLimitService } from './application/services/chat-rate-limit.service';
import { ChatQuotaOpsService } from './application/services/chat-quota-ops.service';
import { CHAT_BURST_COUNTER } from './domain/repositories/chat-burst-counter.port';
import type { ChatBurstCounterPort } from './domain/repositories/chat-burst-counter.port';
import { CHAT_QUOTA_EVENT_REPOSITORY } from './domain/repositories/chat-quota-event.repository.port';
import { CHAT_QUOTA_REPOSITORY } from './domain/repositories/chat-quota.repository.port';
import { ChatQuotaEventRepository } from './infrastructure/persistence/chat-quota-event.repository';
import { ChatRateLimitRepository } from './infrastructure/persistence/chat-rate-limit.repository';

@Module({
  imports: [
    CommonModule,
    TypeOrmModule.forFeature([
      ChatDailyUsageEntity,
      ChatIdempotencyEntity,
      ChatToolDailyUsageEntity,
      ChatQuotaEventEntity,
    ]),
  ],
  providers: [
    {
      provide: PlatformWriteToolBudgetService,
      useFactory: (
        configService: ConfigService,
        toolDailyUsageRepo: Repository<ChatToolDailyUsageEntity>,
        metrics: BotMetricsService,
      ) =>
        new PlatformWriteToolBudgetService(
          { platform: 'messenger' },
          configService,
          toolDailyUsageRepo,
          metrics,
        ),
      inject: [
        ConfigService,
        getRepositoryToken(ChatToolDailyUsageEntity),
        BotMetricsService,
      ],
    },
    ChatRateLimitConfigService,
    ChatRateLimitStartupService,
    {
      provide: CHAT_BURST_COUNTER,
      useFactory: (
        config: ChatRateLimitConfigService,
        repository: ChatRateLimitRepository,
        redisClient: RedisClientPort | null,
      ): ChatBurstCounterPort => {
        const logger = new Logger('ChatBurstCounter');
        const configured = config.getBurstStore();

        if (configured === 'redis') {
          const redisCounter = new RedisBurstCounter(redisClient!);
          const pgFallback = (): PostgresBurstCounter =>
            new PostgresBurstCounter(
              {
                countRecentReservations: (p, since, opts) =>
                  repository.countRecentReservations(p, since, opts),
              },
              config.getBurstCountsRefunded(),
            );
          const counter: ChatBurstCounterPort = {
            async getBurstCount(psid: string): Promise<number> {
              if (redisCounter.isAvailable()) {
                return redisCounter.getBurstCount(psid);
              }
              return pgFallback().getBurstCount(psid);
            },
            async tryReserveBurst(
              psid: string,
              limit: number,
            ): Promise<BurstReservationResult> {
              if (redisCounter.isAvailable()) {
                return redisCounter.tryReserveBurst(psid, limit);
              }
              return pgFallback().tryReserveBurst(psid, limit);
            },
            async releaseReservation(psid: string): Promise<void> {
              if (redisCounter.isAvailable()) {
                return redisCounter.releaseReservation(psid);
              }
              return pgFallback().releaseReservation(psid);
            },
          };
          return counter;
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
        ChatRateLimitRepository,
        { token: REDIS_CLIENT, optional: true },
      ],
    },
    ChatQuotaEventRepository,
    {
      provide: CHAT_QUOTA_EVENT_REPOSITORY,
      useExisting: ChatQuotaEventRepository,
    },
    ChatQuotaEventRecorderService,
    CleanupCronService,
    ChatQuotaEventCleanupCronService,
    ChatRateLimitService,
    ChatQuotaOpsService,
    ChatQuotaStuckRecoveryCronService,
    ChatIdempotencyCleanupCronService,
    ChatRateLimitRepository,
    {
      provide: CHAT_QUOTA_REPOSITORY,
      useExisting: ChatRateLimitRepository,
    },
  ],
  exports: [
    PlatformWriteToolBudgetService,
    ChatRateLimitConfigService,
    ChatRateLimitService,
    ChatQuotaOpsService,
    CHAT_QUOTA_REPOSITORY,
  ],
})
export class ChatRateLimitModule {}
