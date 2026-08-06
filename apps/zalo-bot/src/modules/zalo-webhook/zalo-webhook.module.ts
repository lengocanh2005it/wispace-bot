import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  REDIS_CLIENT,
  RedisWebhookDedupeStore,
  type RedisClientPort,
} from '@wispace/bot-common';
import { ZaloChatModule } from '../zalo-chat/zalo-chat.module';
import { ZaloWebhookController } from './presentation/controllers/zalo-webhook.controller';
import { ZaloWebhookDedupeService } from './application/zalo-webhook-dedupe.service';

@Module({
  imports: [ZaloChatModule],
  controllers: [ZaloWebhookController],
  providers: [
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
