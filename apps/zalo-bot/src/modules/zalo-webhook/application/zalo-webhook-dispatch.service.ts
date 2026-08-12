import { Injectable, Logger } from '@nestjs/common';
import type { ZaloWebhookEvent } from '../domain/entities/zalo-webhook-event.types';
import { ZaloChatService } from '../../zalo-chat/application/services/zalo-chat.service';

/**
 * Applies an authenticated Zalo inbound event: routes it to the chat service
 * and acknowledges unsupported/echo event kinds. Pure dispatch — durability
 * (persist before processing, retry on failure) lives in the controller /
 * inbound inbox.
 */
@Injectable()
export class ZaloWebhookDispatchService {
  private readonly logger = new Logger(ZaloWebhookDispatchService.name);

  constructor(private readonly handler: ZaloChatService) {}

  async dispatch(event: ZaloWebhookEvent): Promise<void> {
    switch (event.event_name) {
      case 'user_send_text': {
        const senderId = event.sender?.id;
        const text = event.message?.text;
        const msgId = event.message?.msg_id;
        if (senderId && text) {
          await this.handler.handleIncomingMessage(senderId, text, msgId);
        }
        return;
      }
      case 'follow': {
        const followerId = event.follower?.id;
        if (followerId) {
          await this.handler.handleFollow(followerId);
        }
        return;
      }
      case 'unfollow':
        this.logger.log(`User unfollowed: ${event.follower?.id ?? 'unknown'}`);
        return;
      default:
        if (event.event_name.startsWith('oa_send_')) {
          // Echo of our own outbound message — ignore to avoid loops.
          return;
        }
        if (event.event_name.startsWith('user_send_')) {
          const senderId = event.sender?.id;
          if (senderId) {
            await this.handler.handleUnsupportedMessage(senderId);
          }
          return;
        }
        this.logger.debug(`Unhandled event_name=${event.event_name}`);
        return;
    }
  }
}
