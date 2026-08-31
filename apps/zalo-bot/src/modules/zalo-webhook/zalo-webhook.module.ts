import { Module } from '@nestjs/common';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';
import {
  ADVISORY_LOCKS,
  PgAdvisoryLockService,
} from '@wispace/bot-common/locks';
import { BotCommonModule } from '@wispace/bot-common/guard';
import { WebhookInboundEventEntity } from '@wispace/database';
import {
  PlatformWebhookInboundCleanupService,
  PlatformWebhookInboundEventService,
  PlatformWebhookInboundRetryCronService,
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
      ) =>
        new PlatformWebhookInboundRetryCronService(
          inboundEvents,
          configService,
          pgLock,
          {
            lockId: ADVISORY_LOCKS.ZALO_WEBHOOK_INBOUND_RETRY,
            processEvent: async (rawPayload) => {
              // Re-validate stored payloads before dispatch — replay must
              // never trust the persisted raw shape (#436).
              await dispatcher.dispatch(
                await validateAndMapZaloEvent(rawPayload),
              );
            },
          },
        ),
      inject: [
        PlatformWebhookInboundEventService,
        ConfigService,
        PgAdvisoryLockService,
        ZaloWebhookDispatchService,
      ],
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
