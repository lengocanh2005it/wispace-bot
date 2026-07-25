/**
 * Port for handling incoming Zalo webhook events.
 * Implemented by ZaloChatService in zalo-chat module.
 */
export interface ZaloWebhookHandler {
  handleIncomingMessage(senderId: string, text: string): Promise<void>;
  handleFollow(senderId: string): Promise<void>;
  /** Called for user_send_* events other than user_send_text (image, sticker, file...) — not supported in this MVP. */
  handleUnsupportedMessage(senderId: string): Promise<void>;
}

export const ZALO_WEBHOOK_HANDLER = 'ZALO_WEBHOOK_HANDLER';
