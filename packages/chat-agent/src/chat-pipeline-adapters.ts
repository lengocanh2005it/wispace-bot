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
import { PlatformAgentService } from './agent/platform-agent.service';
import { PlatformChatHistoryService } from './chat-history/platform-chat-history.service';
import type { PlatformChatRateLimitService } from '@wispace/chat-metering';

/**
 * Minimal outbound service contract — both DiscordOutboundService and
 * ZaloOutboundService satisfy this with their `sendText` method.
 */
export interface OutboundServicePort {
  sendText(externalUserId: string, text: string): Promise<unknown>;
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
    ): Promise<ReserveResult> {
      const result = await rateLimitService.reserve(
        externalUserId,
        idempotencyKey,
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
      await rateLimitService.refund(externalUserId, usageDate, idempotencyKey);
    },
    async markCompleted(idempotencyKey: string): Promise<void> {
      await rateLimitService.markCompleted(idempotencyKey);
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
    ): Promise<void> {
      await historyService.appendTurn(externalUserId, userText, assistantText);
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
      return { text: result.text };
    },
  };

  const outbound: OutboundPort = {
    async sendText(externalUserId: string, text: string): Promise<SendResult> {
      await outboundService.sendText(externalUserId, text);
      return { delivered: true };
    },
  };

  return { rateLimiter, history, agent, outbound };
}
