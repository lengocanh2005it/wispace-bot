import { Logger } from '@nestjs/common';
import type { MessageSenderPort } from '../ports/message-sender.port';
import type { SendMessageInput } from '../types/study-reminder.types';

/** Outbound surface needed to send study reminder texts. */
export interface OutboundMessageSender {
  sendText(externalUserId: string, text: string): Promise<void>;
}

/**
 * Wraps a platform outbound service (`DiscordOutboundService` /
 * `ZaloOutboundService`) to implement the shared `MessageSenderPort` —
 * replaces the near-identical per-app sender classes.
 */
export function wrapMessageSender(
  outbound: OutboundMessageSender,
): MessageSenderPort {
  const logger = new Logger('StudyReminderMessageSender');

  return {
    async sendText(input: SendMessageInput): Promise<void> {
      try {
        await outbound.sendText(input.externalUserId, input.text);
      } catch (error) {
        logger.warn(
          `Failed to send study reminder to externalUserId=${input.externalUserId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        throw error;
      }
    },
  };
}
