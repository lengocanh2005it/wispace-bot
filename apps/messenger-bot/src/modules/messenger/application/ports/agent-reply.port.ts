import type {
  MessengerAgentInput,
  MessengerAgentReply,
} from '../agent/messenger-agent.types';
import type { RescheduleCancellationOutcome } from '@wispace/reschedule-confirm/core';

/**
 * The agent surface consumed by chat processing, the scheduler controller and
 * pipeline wiring (#1088). The shared `PlatformAgentService` implementation
 * lives in infrastructure.
 */
export interface AgentReplyPort {
  reply(input: MessengerAgentInput): Promise<MessengerAgentReply>;
  clearClarificationState(psid: string): Promise<void>;
  cancelPendingReschedule(
    psid: string,
    approvalToken?: string,
  ): Promise<RescheduleCancellationOutcome>;
  markClarificationDeliveryFailedForEvent(
    psid: string,
    eventId?: string,
  ): Promise<void>;
}

export const AGENT_REPLY = Symbol('AGENT_REPLY');
