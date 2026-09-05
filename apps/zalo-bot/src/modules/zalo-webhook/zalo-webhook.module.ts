import { Module } from '@nestjs/common';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';
import {
  ADVISORY_LOCKS,
  PgAdvisoryLockService,
} from '@wispace/bot-common/locks';
import { BotCommonModule } from '@wispace/bot-common/guard';
import { BotMetricsService } from '@wispace/bot-metrics';
import { WebhookInboundEventEntity } from '@wispace/database';
import {
  PlatformWebhookInboundCleanupService,
  PlatformWebhookInboundEventService,
  PlatformWebhookInboundRetryCronService,
  InlineWebhookInboundDispatcher,
  readInboundRetryConfig,
  TRY_INLINE_DISPATCHER,
} from '@wispace/webhook-inbound';
import { ZaloChatModule } from '../zalo-chat/zalo-chat.module';
import { ZaloWebhookController } from './presentation/controllers/zalo-webhook.controller';
import { ZaloWebhookSignatureGuard } from './presentation/guards/zalo-webhook-signature.guard';
import { ZaloWebhookDispatchService } from './application/zalo-webhook-dispatch.service';
import { ZaloWebhookIngestService } from './application/zalo-webhook-ingest.service';
import { validateAndMapZaloEvent } from './presentation/mappers/zalo-webhook.mapper';

@Module({
  imports: [
    ZaloChatModule,
    BotCommonModule,
    TypeOrmModule.forFeature([WebhookInboundEventEntity]),
  ],
  controllers: [ZaloWebhookController],
  providers: [
    ZaloWebhookDispatchService,
    ZaloWebhookSignatureGuard,
    {
      provide: PlatformWebhookInboundEventService,
      useFactory: (repo: Repository<WebhookInboundEventEntity>) =>
        new PlatformWebhookInboundEventService('zalo', repo),
      inject: [getRepositoryToken(WebhookInboundEventEntity)],
    },
    ZaloWebhookIngestService,
    {
      provide: PlatformWebhookInboundRetryCronService,
      useFactory: (
        inboundEvents: PlatformWebhookInboundEventService,
        configService: ConfigService,
        pgLock: PgAdvisoryLockService,
        dispatcher: ZaloWebhookDispatchService,
        metrics: BotMetricsService,
      ) =>
        new PlatformWebhookInboundRetryCronService(
          inboundEvents,
          configService,
          pgLock,
          {
            lockId: ADVISORY_LOCKS.ZALO_WEBHOOK_INBOUND_RETRY,
            cronName: 'zalo-webhook-inbound-retry',
            metrics,
            processEvent: async (rawPayload) => {
              // Re-validate stored payloads before dispatch — replay must
              // never trust the persisted raw shape (#436).
              await dispatcher.dispatch(
                await validateAndMapZaloEvent(rawPayload),
              );
            },
            onTickComplete: (stats) =>
              metrics.setWebhookInboundBacklog(stats.backlog),
          },
        ),
      inject: [
        PlatformWebhookInboundEventService,
        ConfigService,
        PgAdvisoryLockService,
        ZaloWebhookDispatchService,
        BotMetricsService,
      ],
    },
    {
      provide: InlineWebhookInboundDispatcher,
      useFactory: (
        inboundEvents: PlatformWebhookInboundEventService,
        dispatcher: ZaloWebhookDispatchService,
        configService: ConfigService,
      ) => {
        const retryConfig = readInboundRetryConfig((key) =>
          configService.get<string>(key),
        );
        return new InlineWebhookInboundDispatcher(inboundEvents, 'zalo', {
          processEvent: async (rawPayload) => {
            await dispatcher.dispatch(
              await validateAndMapZaloEvent(rawPayload),
            );
          },
          retryConfig,
        });
      },
      inject: [
        PlatformWebhookInboundEventService,
        ZaloWebhookDispatchService,
        ConfigService,
      ],
    },
    {
      provide: TRY_INLINE_DISPATCHER,
      useFactory:
        (dispatcher: InlineWebhookInboundDispatcher) =>
        (
          id: number,
          rawPayload: object,
          meta: { ingestedAt: Date; eventId: string; externalUserId: string },
        ) =>
          dispatcher.tryInline(id, rawPayload, meta),
      inject: [InlineWebhookInboundDispatcher],
    },
    {
      provide: PlatformWebhookInboundCleanupService,
      useFactory: (
        inboundEvents: PlatformWebhookInboundEventService,
        configService: ConfigService,
        pgLock: PgAdvisoryLockService,
      ) =>
        new PlatformWebhookInboundCleanupService(
          inboundEvents,
          configService,
          pgLock,
          { lockId: ADVISORY_LOCKS.ZALO_WEBHOOK_INBOUND_CLEANUP },
        ),
      inject: [
        PlatformWebhookInboundEventService,
        ConfigService,
        PgAdvisoryLockService,
      ],
    },
  ],
})
export class ZaloWebhookModule {}
