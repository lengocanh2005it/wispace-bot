import type { MessengerWebhookEvent } from '../entities/messenger.types';

type UserMessage = NonNullable<MessengerWebhookEvent['message']>;

/** L1: có attachment hoặc sticker, không có text hợp lệ. */
export function isUnsupportedUserMessage(message: UserMessage): boolean {
  if (message.text?.trim()) {
    return false;
  }

  if (message.sticker_id != null) {
    return true;
  }

  return (message.attachments?.length ?? 0) > 0;
}
