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
import type { ChatQuotaCheckResult } from '@wispace/chat-metering';
import {
  PlatformAgentService,
  PlatformChatHistoryService,
} from '@wispace/chat-agent';
import { PlatformChatRateLimitService } from '@wispace/chat-metering';
import { DiscordOutboundService } from '../../application/services/discord-outbound.service';

/**
 * Platform-specific port adapters that map Discord services to the
 * framework-agnostic `@wispace/chat-pipeline` port interfaces.
 */

export class DiscordRateLimiterAdapter implements RateLimiterPort {
  constructor(
    private readonly rateLimitService: PlatformChatRateLimitService,
  ) {}

  async reserve(
    externalUserId: string,
    idempotencyKey: string,
  ): Promise<ReserveResult> {
    const result: ChatQuotaCheckResult =
      await this.rateLimitService.reserveFreeFormSlot(externalUserId, {
        idempotencyKey,
      });
    return {
      allowed: result.allowed,
      usageDate: result.usageDate,
      reason: result.reason,
    };
  }

  async refund(
    externalUserId: string,
    usageDate: string,
    idempotencyKey: string,
  ): Promise<void> {
    await this.rateLimitService.refundFreeFormSlot(
      externalUserId,
      usageDate,
      idempotencyKey,
    );
  }

  async markCompleted(idempotencyKey: string): Promise<void> {
    await this.rateLimitService.markCompleted(idempotencyKey);
  }
}

export class DiscordHistoryAdapter implements HistoryPort {
  constructor(private readonly historyService: PlatformChatHistoryService) {}

  async getHistory(
    externalUserId: string,
  ): Promise<readonly ChatHistoryMessage[]> {
    return this.historyService.getHistory(externalUserId);
  }

  async appendTurn(
    externalUserId: string,
    userText: string,
    assistantText: string,
  ): Promise<void> {
    await this.historyService.appendTurn(
      externalUserId,
      userText,
      assistantText,
    );
  }
}

export class DiscordAgentAdapter implements AgentPort {
  constructor(private readonly agentService: PlatformAgentService) {}

  async reply(input: AgentInput): Promise<AgentReply> {
    const result = await this.agentService.reply({
      externalUserId: input.externalUserId,
      userId: input.userId,
      userText: input.userText,
      correlationId: input.correlationId,
      isServerChannel: input.context?.isServerChannel === true,
    });
    return { text: result.text };
  }
}

export class DiscordOutboundAdapter implements OutboundPort {
  constructor(private readonly outboundService: DiscordOutboundService) {}

  async sendText(externalUserId: string, text: string): Promise<SendResult> {
    await this.outboundService.sendText(externalUserId, text);
    return { delivered: true };
  }
}
