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
import type { OutboundDeliveryOutcome } from '@wispace/contracts';
import { PlatformAgentService } from './agent/platform-agent.service';
import { PlatformChatHistoryService } from './chat-history/platform-chat-history.service';
import type { PlatformChatRateLimitService } from '@wispace/chat-metering';

/**
 * Minimal outbound service contract — both DiscordOutboundService and
 * ZaloOutboundService satisfy this with their `sendText` method.
 */
export interface OutboundServicePort {
  sendText(
    externalUserId: string,
    text: string,
    options?: {
      deliveryKey?: string;
      clarification?: boolean;
      userId?: number;
    },
  ): Promise<OutboundDeliveryOutcome | void>;
  isAmbiguousDeliveryError?(error: unknown): boolean;
}

/**
 * Creates the four port adapters that plug into `ChatPipeline` /
 * `PlatformChatQueueService` for any platform.
 *
 * Shared services (rate limit, history, agent) are platform-agnostic.
 * Only the outbound service and optional flags differ per platform.
 */
export function createChatPipelineAdapters(
  rateLimitService: PlatformChatRateLimitService,
  historyService: PlatformChatHistoryService,
  agentService: PlatformAgentService,
  outboundService: OutboundServicePort,
  options?: { isServerChannel?: boolean },
) {
  const rateLimiter: RateLimiterPort = {
    async reserve(
      externalUserId: string,
      idempotencyKey: string,
      context?: Record<string, unknown>,
    ): Promise<ReserveResult> {
      const result =
        typeof context?.userId === 'number'
          ? await rateLimitService.reserve(externalUserId, idempotencyKey, {
              userId: context.userId,
            })
          : await rateLimitService.reserve(externalUserId, idempotencyKey);
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
      await rateLimitService.refund(externalUserId, usageDate, idempotencyKey);
    },
    async markCompleted(idempotencyKey: string): Promise<void> {
      await rateLimitService.markCompleted(idempotencyKey);
    },
    async markDelivered(idempotencyKey: string): Promise<void> {
      await rateLimitService.markDelivered(idempotencyKey);
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
      const result = await agentService.reply({
        externalUserId: input.externalUserId,
        userId: input.userId,
        userText: input.userText,
        history: input.history,
        correlationId: input.correlationId,
        ...(options?.isServerChannel ? { isServerChannel: true } : {}),
      });
      return {
        text: result.text,
        ...(result.toolSummary ? { toolSummary: result.toolSummary } : {}),
        ...(result.richFollowUps
          ? { richFollowUps: result.richFollowUps }
          : {}),
        ...(result.privateDataFetched ? { privateDataFetched: true } : {}),
        ...(result.skipHistory ? { skipHistory: true } : {}),
        ...(result.deliveryKey ? { deliveryKey: result.deliveryKey } : {}),
        ...(result.clarification ? { clarification: true } : {}),
        ...(result.skipDelivery ? { skipDelivery: true } : {}),
      };
    },
  };

  const outbound: OutboundPort = {
    isAmbiguousDeliveryError: (error) =>
      outboundService.isAmbiguousDeliveryError?.(error) === true,
    async sendText(
      externalUserId: string,
      text: string,
      context?: Record<string, unknown>,
    ): Promise<SendResult> {
      const outcome = await outboundService.sendText(externalUserId, text, {
        ...(typeof context?.userId === 'number'
          ? { userId: context.userId }
          : {}),
        ...(typeof context?.deliveryKey === 'string'
          ? { deliveryKey: context.deliveryKey }
          : {}),
        ...(context?.clarification === true ? { clarification: true } : {}),
      });
      if (outcome === 'rate_limited') {
        return { delivered: false, outcome };
      }
      if (outcome === 'ambiguous' || outcome === 'not_sent') {
        return { delivered: false, outcome };
      }
      return { delivered: true, outcome: 'sent' };
    },
  };

  return { rateLimiter, history, agent, outbound };
}
