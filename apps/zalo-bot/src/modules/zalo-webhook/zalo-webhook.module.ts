import { Module } from '@nestjs/common';
import { ZaloChatModule } from '../zalo-chat/zalo-chat.module';
import { ZaloChatService } from '../zalo-chat/application/services/zalo-chat.service';
import { ZALO_WEBHOOK_HANDLER } from './domain/ports/zalo-webhook-handler.port';
import { ZaloWebhookController } from './presentation/controllers/zalo-webhook.controller';
import { ZaloWebhookDedupeService } from './application/zalo-webhook-dedupe.service';
import { RedisWebhookDedupeStore } from './application/redis-webhook-dedupe.store';

@Module({
  imports: [ZaloChatModule],
  controllers: [ZaloWebhookController],
  providers: [
    { provide: ZALO_WEBHOOK_HANDLER, useExisting: ZaloChatService },
    ZaloWebhookDedupeService,
    RedisWebhookDedupeStore,
  ],
})
export class ZaloWebhookModule {}
