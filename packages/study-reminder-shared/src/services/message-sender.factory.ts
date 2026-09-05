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
    input?: SendMessageInput & {
      /** Scheduler owns reminder retries; disable transport retries at this boundary. */
      retryOn?: 'all' | 'none';
      /** Reminder failures are persisted on the reminder job, not dead-lettered. */
      skipDeadLetter?: boolean;
      deadLetterOn?: 'all' | 'ambiguous' | 'none';
    },
  ): Promise<OutboundDeliveryOutcome>;
  /** Provider-specific classifier for errors with no delivery verdict. */
  isAmbiguousDeliveryError?(error: unknown): boolean;
}

/**
 * Wraps a platform outbound service (`DiscordOutboundService` /
 * `ZaloOutboundService`) to implement the shared `MessageSenderPort` —
 * replaces the near-identical per-app sender classes. The full input is
 * forwarded as an optional 3rd arg so messenger can keep messageType/userId
 * in its message log; discord/zalo ignore it.
 *
 * The wrapper is the reminder boundary: explicit provider outcomes pass
 * through unchanged, while provider errors are normalized into the same
 * authoritative outcome contract. Transport retries/dead letters are
 * disabled so the shared job owns retry and recovery semantics.
 */
export function wrapMessageSender(
  outbound: OutboundMessageSender,
): MessageSenderPort {
  const logger = new Logger('StudyReminderMessageSender');

  return {
    async sendText(input: SendMessageInput): Promise<OutboundDeliveryOutcome> {
      try {
        const outcome = await outbound.sendText(
          input.externalUserId,
          input.text,
          {
            ...input,
            retryOn: 'none',
            skipDeadLetter: true,
            deadLetterOn: 'none',
          },
        );
        if (
          outcome === 'sent' ||
          outcome === 'ambiguous' ||
          outcome === 'not_sent' ||
          outcome === 'rate_limited'
        ) {
          return outcome;
        }
        // An omitted outcome is not an acknowledgement. Keep the reminder
        // retryable instead of silently recording a successful delivery.
        return 'not_sent';
      } catch (error) {
        const ambiguous = outbound.isAmbiguousDeliveryError?.(error) === true;
        logger.warn(
          `Study reminder send outcome=${
            ambiguous ? 'ambiguous' : 'not_sent'
          } externalUserId=${maskExternalId(input.externalUserId)}: ${errorMessage(error)}`,
        );
        // Keep the original error for Messenger's 24h/non-retryable
        // classifier. A thrown error is the authoritative not_sent signal;
        // only a provider classifier can safely turn it into ambiguous here.
        if (ambiguous) return 'ambiguous';
        throw error;
      }
    },
  };
}
