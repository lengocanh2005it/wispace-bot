import type {
  AgentPort,
  AgentInput,
  AgentReply,
  HistoryPort,
  OutboundPort,
  RateLimiterPort,
  ReserveResult,
  SendResult,
  ChatHistoryMessage,
} from '@wispace/chat-pipeline';
import { PlatformChatHistoryService } from '@wispace/chat-agent';
import type { ChatRateLimitService } from '@messenger/modules/chat-rate-limit/application/services/chat-rate-limit.service';
import { MessengerAgentService } from '@messenger/modules/messenger/application/agent/messenger-agent.service';
import {
  MessengerOutboundService,
  isMessengerAmbiguousDeliveryError,
  MessengerPartialSendError,
} from '@messenger/modules/messenger/application/services/messenger-outbound.service';
import { readMessengerBubbleLimits } from '@messenger/modules/messenger/application/utils/messenger-bubble-config.utils';
import { ConfigService } from '@nestjs/config';
import type { MessengerLinkContext } from '@messenger/shared/config/poc.constants';

/**
 * Creates the four port adapters that plug into `ChatPipeline` for Messenger.
 *
 * Messenger-specific behavior:
 * - Outbound: bubble splitting via `sendTextBubblesViaPsid`, partial delivery
 * - Rate limiter: rich `ChatQuotaCheckResult` → simple `ReserveResult`
 * - History: `appendTurn` + `appendToolSummary`
 * - Agent: Messenger input shape (psid, linkContext)
 */
export function createMessengerChatPipelineAdapters(
  chatRateLimitService: ChatRateLimitService,
  historyService: PlatformChatHistoryService,
  agentService: MessengerAgentService,
  outboundService: MessengerOutboundService,
  configService: ConfigService,
) {
  const rateLimiter: RateLimiterPort = {
    async reserve(
      externalUserId: string,
      idempotencyKey: string,
      context?: Record<string, unknown>,
    ): Promise<ReserveResult> {
      const userId =
        typeof context?.userId === 'number' ? context.userId : undefined;
      const result = await chatRateLimitService.reserveFreeFormSlot(
        externalUserId,
        {
          userId,
          idempotencyKey,
        },
      );
      return {
        allowed: result.allowed,
        usageDate: result.usageDate,
        reason: result.reason,
      };
    },
    async refund(
      externalUserId: string,
      usageDate: string,
      idempotencyKey: string,
    ): Promise<void> {
      await chatRateLimitService.refundFreeFormSlot(
        externalUserId,
        usageDate,
        idempotencyKey,
      );
    },
    async markCompleted(idempotencyKey: string): Promise<void> {
      await chatRateLimitService.markCompleted(idempotencyKey);
    },
    async markDelivered(idempotencyKey: string): Promise<void> {
      await chatRateLimitService.markDelivered(idempotencyKey);
    },
  };

  const history: HistoryPort = {
    async getHistory(
      externalUserId: string,
    ): Promise<readonly ChatHistoryMessage[]> {
      return historyService.getHistory(externalUserId);
    },
    async appendTurn(
      externalUserId: string,
      userText: string,
      assistantText: string,
      toolSummary?: string,
    ): Promise<void> {
      await historyService.appendTurn(externalUserId, userText, assistantText);
      if (toolSummary) {
        await historyService.appendToolSummary(externalUserId, toolSummary);
      }
    },
  };

  const agent: AgentPort = {
    async reply(input: AgentInput): Promise<AgentReply> {
      const linkContext = input.context?.linkContext as
        | MessengerLinkContext
        | undefined;
      const result = await agentService.reply({
        psid: input.externalUserId,
        userId: input.userId,
        userText: input.userText,
        history: [...input.history],
        correlationId: input.correlationId,
        linkContext,
      });
      return {
        text: result.text,
        toolSummary: result.toolSummary,
        richFollowUps: result.richFollowUps,
        ...(result.skipHistory ? { skipHistory: true } : {}),
        ...(result.deliveryKey ? { deliveryKey: result.deliveryKey } : {}),
        ...(result.clarification ? { clarification: true } : {}),
        ...(result.skipDelivery ? { skipDelivery: true } : {}),
      };
    },
  };

  const outbound: OutboundPort = {
    isAmbiguousDeliveryError: isMessengerAmbiguousDeliveryError,
    async sendText(
      externalUserId: string,
      text: string,
      context?: Record<string, unknown>,
    ): Promise<SendResult> {
      const userId =
        typeof context?.userId === 'number' ? context.userId : undefined;
      const limits = readMessengerBubbleLimits(configService);
      try {
        const bubblesSent = await outboundService.sendTextBubblesViaPsid({
          psid: externalUserId,
          userId,
          text,
          messageType: 'FREE_FORM_CHAT_OUT',
          maxBubbles: Math.min(limits.maxBubbles, 10),
          maxCharsPerBubble: Math.min(limits.maxCharsPerBubble, 2000),
          ...(typeof context?.deliveryKey === 'string'
            ? { deliveryKey: context.deliveryKey }
            : {}),
          ...(context?.clarification === true ? { clarification: true } : {}),
        });
        if (bubblesSent === 'rate_limited') {
          return { delivered: false, outcome: 'rate_limited' };
        }
        return { delivered: bubblesSent > 0 };
      } catch (error: unknown) {
        if (
          error instanceof MessengerPartialSendError &&
          error.bubblesSent > 0
        ) {
          return { delivered: true, partial: true };
        }
        throw error;
      }
    },
  };

  return { rateLimiter, history, agent, outbound };
}
