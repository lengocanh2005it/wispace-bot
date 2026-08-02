import { Module } from '@nestjs/common';
import { InternalApiKeyGuard } from '@wispace/bot-common';
import { MessengerWebhookSignatureGuard } from './guards/messenger-webhook-signature.guard';
import { PgAdvisoryLockService } from '@wispace/bot-common';

@Module({
  providers: [
    InternalApiKeyGuard,
    MessengerWebhookSignatureGuard,
    PgAdvisoryLockService,
  ],
  exports: [
    InternalApiKeyGuard,
    MessengerWebhookSignatureGuard,
    PgAdvisoryLockService,
  ],
})
export class CommonModule {}
