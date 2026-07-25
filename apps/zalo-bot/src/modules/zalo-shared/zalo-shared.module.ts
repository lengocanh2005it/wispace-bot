import { Global, Module } from '@nestjs/common';
import { ZaloChatModule } from '../zalo-chat/zalo-chat.module';
import { ZaloOutboundService } from '../zalo-chat/application/services/zalo-outbound.service';
import { ZALO_MESSAGE_SENDER } from '../zalo-webhook/domain/ports/zalo-message-sender.port';

/**
 * Global module that provides shared tokens (ZALO_MESSAGE_SENDER) to all
 * modules without explicit imports — avoids circular dependency between
 * ZaloOauthModule ↔ ZaloChatModule.
 */
@Global()
@Module({
  imports: [ZaloChatModule],
  providers: [
    { provide: ZALO_MESSAGE_SENDER, useExisting: ZaloOutboundService },
  ],
  exports: [ZALO_MESSAGE_SENDER],
})
export class ZaloSharedModule {}
