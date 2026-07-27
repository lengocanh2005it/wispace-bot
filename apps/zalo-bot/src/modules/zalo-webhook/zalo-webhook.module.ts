import { Module } from '@nestjs/common';
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
  ],
})
export class ZaloWebhookModule {}
