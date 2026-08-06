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
import {
  PlatformAgentService,
  PlatformChatHistoryService,
} from '@wispace/chat-agent';
import { ZaloChatRateLimitService } from '../../infrastructure/persistence/zalo-chat-rate-limit.service';
import { ZaloOutboundService } from '../../application/services/zalo-outbound.service';

export class ZaloRateLimiterAdapter implements RateLimiterPort {
  constructor(private readonly rateLimitService: ZaloChatRateLimitService) {}

  async reserve(
    externalUserId: string,
    idempotencyKey: string,
  ): Promise<ReserveResult> {
    const result = await this.rateLimitService.reserve(
      externalUserId,
      idempotencyKey,
    );
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
    await this.rateLimitService.refund(
      externalUserId,
      usageDate,
      idempotencyKey,
    );
  }

  async markCompleted(idempotencyKey: string): Promise<void> {
    await this.rateLimitService.markCompleted(idempotencyKey);
  }
}

export class ZaloHistoryAdapter implements HistoryPort {
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

export class ZaloAgentAdapter implements AgentPort {
  constructor(private readonly agentService: PlatformAgentService) {}

  async reply(input: AgentInput): Promise<AgentReply> {
    const result = await this.agentService.reply({
      externalUserId: input.externalUserId,
      userId: input.userId,
      userText: input.userText,
      correlationId: input.correlationId,
    });
    return { text: result.text };
  }
}

export class ZaloOutboundAdapter implements OutboundPort {
  constructor(private readonly outboundService: ZaloOutboundService) {}

  async sendText(externalUserId: string, text: string): Promise<SendResult> {
    await this.outboundService.sendText(externalUserId, text);
    return { delivered: true };
  }
}
