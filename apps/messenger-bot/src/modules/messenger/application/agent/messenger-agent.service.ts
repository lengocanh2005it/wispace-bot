import { Injectable } from '@nestjs/common';
import { PlatformAgentService } from '@wispace/chat-agent';
import type { MessengerRichFollowUp } from '../../domain/entities/messenger-rich-message.types';
import type {
  MessengerAgentReply,
  MessengerAgentStreamEvent,
  MessengerAgentInput,
} from './messenger-agent.types';

export type {
  MessengerAgentReply,
  MessengerAgentStreamEvent,
  MessengerAgentInput,
} from './messenger-agent.types';

/**
 * Messenger adapter over the shared `PlatformAgentService` — maps the
 * Messenger input/reply shapes (psid, linkContext, richFollowUps) that
 * MessengerChatQueueService consumes onto the platform-neutral ones.
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
    });

    return {
      text: result.text,
      richFollowUps: (result.richFollowUps ?? []) as MessengerRichFollowUp[],
      exhausted: result.exhausted,
      toolSummary: result.toolSummary,
    };
  }

  async *replyStream(
    input: MessengerAgentInput,
  ): AsyncIterable<MessengerAgentStreamEvent> {
    try {
      const reply = await this.reply(input);
      yield { type: 'delta', textDelta: reply.text };
      yield { type: 'done', reply };
    } catch (error) {
      yield { type: 'error', error };
    }
  }
}
