import { Module } from '@nestjs/common';
import { BotCommonModule } from '@wispace/bot-common';
import { MessengerWebhookSignatureGuard } from './guards/messenger-webhook-signature.guard';

@Module({
  imports: [BotCommonModule],
  providers: [MessengerWebhookSignatureGuard],
  exports: [BotCommonModule, MessengerWebhookSignatureGuard],
})
export class CommonModule {}
