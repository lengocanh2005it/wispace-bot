import { Logger } from '@nestjs/common';
import { errorMessage, maskExternalId } from '@wispace/bot-common/masking';
import type { OutboundDeliveryOutcome } from '@wispace/contracts';
import type { MessageSenderPort } from '../ports/message-sender.port';
import type { SendMessageInput } from '../types/study-reminder.types';

/** Outbound surface needed to send study reminder texts. */
export interface OutboundMessageSender {
  sendText(
    externalUserId: string,
    text: string,
    input?: SendMessageInput,
  ): Promise<void>;
}

/**
 * Wraps a platform outbound service (`DiscordOutboundService` /
 * `ZaloOutboundService`) to implement the shared `MessageSenderPort` —
 * replaces the near-identical per-app sender classes. The full input is
 * forwarded as an optional 3rd arg so messenger can keep messageType/userId
 * in its message log; discord/zalo ignore it.
 *
 * The wrapped sender always returns `'sent'` on success (the caller owns
 * outcome classification for ambiguous/not_sent via catch blocks).
 */
export function wrapMessageSender(
  outbound: OutboundMessageSender,
): MessageSenderPort {
  const logger = new Logger('StudyReminderMessageSender');

  return {
    async sendText(input: SendMessageInput): Promise<OutboundDeliveryOutcome> {
      try {
        await outbound.sendText(input.externalUserId, input.text, input);
        return 'sent';
      } catch (error) {
        logger.warn(
          `Failed to send study reminder to externalUserId=${maskExternalId(
            input.externalUserId,
          )}: ${errorMessage(error)}`,
        );
        throw error;
      }
    },
  };
}
