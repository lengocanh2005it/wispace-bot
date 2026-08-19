import type { OutboundDeliveryOutcome } from '@wispace/database';
import type { SendMessageInput } from '../types/study-reminder.types';

export const MESSAGE_SENDER = Symbol('MESSAGE_SENDER');

export interface MessageSenderPort {
  sendText(input: SendMessageInput): Promise<OutboundDeliveryOutcome>;
}
