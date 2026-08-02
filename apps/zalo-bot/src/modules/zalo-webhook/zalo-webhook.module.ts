import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  REDIS_CLIENT,
  RedisWebhookDedupeStore,
  type RedisClientPort,
} from '@wispace/bot-common';
import { ZaloChatModule } from '../zalo-chat/zalo-chat.module';
import { ZaloChatService } from '../zalo-chat/application/services/zalo-chat.service';
import { ZALO_WEBHOOK_HANDLER } from './domain/ports/zalo-webhook-handler.port';
import { ZaloWebhookController } from './presentation/controllers/zalo-webhook.controller';
import { ZaloWebhookDedupeService } from './application/zalo-webhook-dedupe.service';

@Module({
  imports: [ZaloChatModule],
  controllers: [ZaloWebhookController],
  providers: [
    { provide: ZALO_WEBHOOK_HANDLER, useExisting: ZaloChatService },
    ZaloWebhookDedupeService,
    {
      provide: RedisWebhookDedupeStore,
      useFactory: (
        redisClient: RedisClientPort,
        configService: ConfigService,
      ) =>
        new RedisWebhookDedupeStore(redisClient, {
          platform: 'zalo',
          midTtlSeconds: () =>
            Math.max(
              1,
              configService.get<number>('ZALO_WEBHOOK_DEDUPE_TTL_SECONDS') ??
                60,
            ),
        }),
      inject: [REDIS_CLIENT, ConfigService],
    },
  ],
})
export class ZaloWebhookModule {}
