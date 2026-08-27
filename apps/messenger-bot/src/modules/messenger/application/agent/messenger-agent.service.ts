import { Injectable } from '@nestjs/common';
import { PlatformAgentService } from '@wispace/chat-agent';
import type { MessengerRichFollowUp } from '../../domain/entities/messenger-rich-message.types';
import type {
  MessengerAgentReply,
  MessengerAgentInput,
} from './messenger-agent.types';

export type {
  MessengerAgentReply,
  MessengerAgentInput,
} from './messenger-agent.types';

/**
 * Messenger adapter over the shared `PlatformAgentService` — maps the
 * Messenger input/reply shapes (psid, linkContext, richFollowUps) that
 * MessengerChatProcessorService consumes onto the platform-neutral ones.
 */
@Injectable()
export class MessengerAgentService {
  constructor(private readonly platformAgent: PlatformAgentService) {}

  async reply(input: MessengerAgentInput): Promise<MessengerAgentReply> {
    const result = await this.platformAgent.reply({
      externalUserId: input.psid,
      userId: input.userId,
      userText: input.userText,
      correlationId: input.correlationId,
      history: input.history,
      linkContext: input.linkContext,
      signal: input.signal,
    });

    return {
      text: result.text,
      richFollowUps: (result.richFollowUps ?? []) as MessengerRichFollowUp[],
      exhausted: result.exhausted,
      toolSummary: result.toolSummary,
      skipHistory: result.skipHistory,
      deliveryKey: result.deliveryKey,
      clarification: result.clarification,
      skipDelivery: result.skipDelivery,
    };
  }

  async clearClarificationState(psid: string): Promise<void> {
    await this.platformAgent.clearClarificationState(psid);
  }

  async markClarificationDeliveryFailedForEvent(
    psid: string,
    eventId?: string,
  ): Promise<void> {
    await this.platformAgent.markClarificationDeliveryFailedForEvent(
      psid,
      eventId,
    );
  }
}
