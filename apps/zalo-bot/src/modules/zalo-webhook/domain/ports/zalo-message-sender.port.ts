export const ZALO_MESSAGE_SENDER = 'ZALO_MESSAGE_SENDER';

/**
 * Port for sending messages to Zalo users.
 * Implemented by ZaloOutboundService in zalo-chat module.
 */
export interface ZaloMessageSenderPort {
  sendText(zaloUserId: string, text: string): Promise<void>;
}
