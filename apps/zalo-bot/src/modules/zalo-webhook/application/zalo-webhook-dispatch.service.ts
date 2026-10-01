import { Inject, Injectable, Logger } from '@nestjs/common';
import { maskExternalId } from '@wispace/bot-common/masking';
import type { ZaloWebhookEvent } from '../domain/entities/zalo-webhook-event.types';
import { buildZaloEventId } from './zalo-webhook-ingest.service';
import {
  ZALO_INBOUND_CHAT,
  type ZaloInboundChatPort,
} from './ports/inbound-chat.port';

/**
 * Applies an authenticated Zalo inbound event: routes it to the chat service
 * and acknowledges unsupported/echo event kinds. Pure dispatch — durability
 * (persist before processing, retry on failure) lives in the controller /
 * inbound inbox.
 */
@Injectable()
export class ZaloWebhookDispatchService {
  private readonly logger = new Logger(ZaloWebhookDispatchService.name);

  constructor(
    @Inject(ZALO_INBOUND_CHAT) private readonly handler: ZaloInboundChatPort,
  ) {}

  async dispatch(event: ZaloWebhookEvent): Promise<void> {
    switch (event.event_name) {
      case 'user_send_text': {
        const senderId = event.sender?.id;
        const text = event.message?.text;
        if (senderId && text) {
          // #1489: the dedupe key must be derived from the event, never from a
          // clock reading — the same helper the durable inbox uses, so a
          // redelivery of this exact event always yields the same key.
          await this.handler.handleIncomingMessage(
            senderId,
            text,
            buildZaloEventId(event),
          );
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
        this.logger.log(
          `User unfollowed: ${maskExternalId(event.follower?.id ?? 'unknown')}`,
        );
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
