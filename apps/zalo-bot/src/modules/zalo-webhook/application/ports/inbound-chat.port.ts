/**
 * The inbound-chat capability zalo-webhook needs from zalo-chat.
 *
 * Narrow by design: the dispatcher only routes authenticated Zalo events to
 * the chat entry points. Conversation policy, intent detection and delivery
 * stay inside zalo-chat behind the seam.
 */
export interface ZaloInboundChatPort {
  handleIncomingMessage(
    zaloUserId: string,
    text: string,
    idempotencyKey?: string,
  ): Promise<void>;
  handleFollow(zaloUserId: string): Promise<void>;
  handleUnsupportedMessage(zaloUserId: string): Promise<void>;
}

export const ZALO_INBOUND_CHAT = Symbol('ZALO_INBOUND_CHAT');
