import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  LlmAgentService,
  LlmAgentPorts,
  NOOP_METRICS_PORT,
  ToolExecutorPort,
  retryWithBackoff,
  type LlmProviderAdapter,
  loadSystemPromptFile,
} from '@wispace/llm-agent';
import { join } from 'path';
import type {
  DiscordAgentInput,
  DiscordAgentReply,
  DiscordAgentToolContext,
} from '../../domain/entities/discord-chat.types';
import { DiscordAgentToolsService } from './discord-agent-tools.service';
import { DiscordChatHistoryService } from '../services/discord-chat-history.service';
import {
  PlatformLlmUsageRecorderAdapter,
  PlatformLlmSafetyEventAdapter,
} from '@wispace/chat-metering';

const FEATURE = 'FREE_FORM_CHAT';

const DEFAULT_MAX_CONCURRENT = 3;

/**
 * Thin NestJS adapter around `@wispace/llm-agent`'s platform-agnostic
 * orchestration loop — Discord counterpart to `MessengerAgentService`.
 * Usage/safety events persist via `@wispace/chat-metering` (platform='discord').
 * Includes p-limit concurrency cap to prevent overwhelming the LLM provider.
 */
@Injectable()
export class DiscordAgentService {
  private readonly logger = new Logger(DiscordAgentService.name);
  private readonly promptDir = join(__dirname, '../../../../shared/prompts');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly limiter: (fn: () => Promise<any>) => Promise<any>;
  private agent?: LlmAgentService<DiscordAgentToolContext>;

  constructor(
    private readonly configService: ConfigService,
    private readonly toolsService: DiscordAgentToolsService,
    private readonly historyService: DiscordChatHistoryService,
    private readonly usageRecorder: PlatformLlmUsageRecorderAdapter,
    private readonly safetyEventService: PlatformLlmSafetyEventAdapter,
    @Inject('LLM_PROVIDER_ADAPTER')
    private readonly adapter: LlmProviderAdapter,
  ) {
    const maxConcurrent = Number(
      this.configService.get<string>('LLM_MAX_CONCURRENT') ??
        DEFAULT_MAX_CONCURRENT,
    );
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pLimit = require('p-limit') as (
      concurrency: number,
    ) => <T>(fn: () => Promise<T>) => Promise<T>;
    this.limiter = pLimit(
      Number.isFinite(maxConcurrent) && maxConcurrent > 0
        ? maxConcurrent
        : DEFAULT_MAX_CONCURRENT,
    );
  }

  async reply(input: DiscordAgentInput): Promise<DiscordAgentReply> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return this.limiter(() => this.replyInternal(input));
  }

  private async replyInternal(
    input: DiscordAgentInput,
  ): Promise<DiscordAgentReply> {
    if (!this.agent) {
      this.agent = this.buildAgent();
    }

    const toolContext: DiscordAgentToolContext = {
      discordUserId: input.discordUserId,
      userId: input.userId,
      isServerChannel: input.isServerChannel,
      privateDataFetched: false,
    };

    const history = await this.historyService.getHistory(input.discordUserId);

    const result = await this.agent.reply(
      {
        externalUserId: input.discordUserId,
        userId: input.userId,
        userText: input.userText,
        systemPrompt: this.buildSystemPrompt(),
        history,
        correlationId: input.correlationId,
      },
      toolContext,
    );

    await this.historyService.appendTurn(
      input.discordUserId,
      input.userText,
      result.text,
    );

    return {
      text: result.text,
      privateDataFetched: toolContext.privateDataFetched,
    };
  }

  private buildAgent(): LlmAgentService<DiscordAgentToolContext> {
    const toolExecutor: ToolExecutorPort<DiscordAgentToolContext> = {
      execute: (toolName, argsJson, ctx) =>
        this.toolsService.execute(toolName, argsJson, ctx),
    };

    const ports: LlmAgentPorts<DiscordAgentToolContext> = {
      // ponytail: shared retry helper from llm-agent (was 3 local copies of sleep+backoff)
      llmExecution: {
        run: (fn) =>
          retryWithBackoff(fn, {
            maxAttempts: 3,
            baseDelayMs: 500,
            isRetryable: (error) => this.adapter.isRetryableError(error),
            onRetry: (attempt, backoffMs, error) =>
              this.logger.warn(
                `LLM provider retry attempt=${attempt}/3 backoffMs=${backoffMs}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              ),
          }),
      },
      usageRecorder: {
        recordFromCompletion: (params) =>
          this.usageRecorder.recordFromCompletion({
            feature: FEATURE,
            externalUserId: params.externalUserId,
            userId: params.userId,
            model: params.model,
            response: params.response as Parameters<
              PlatformLlmUsageRecorderAdapter['recordFromCompletion']
            >[0]['response'],
            correlationId: params.correlationId,
            toolRound: params.toolRound,
          }),
      },
      safetyEvents: {
        recordGroundingWarning: (params) =>
          this.safetyEventService.recordGroundingWarning({
            externalUserId: params.externalUserId,
            userId: params.userId,
            correlationId: params.correlationId,
            reason: params.reason,
            userTextPreview: params.userTextPreview,
            assistantTextPreview: params.assistantTextPreview,
            toolNamesUsed: params.toolNamesUsed,
          }),
      },
      metrics: NOOP_METRICS_PORT,
      toolExecutor,
      adapter: this.adapter,
      logger: {
        warn: (message) => this.logger.warn(message),
        debug: (message) => this.logger.debug(message),
      },
    };

    return new LlmAgentService<DiscordAgentToolContext>(
      {
        maxToolRounds: Number(
          this.configService.get<string>('OPENAI_MAX_TOOL_ROUNDS'),
        ),
        maxContextChars: Number(
          this.configService.get<string>('OPENAI_MAX_CONTEXT_CHARS'),
        ),
        maxOutputTokens: Number(
          this.configService.get<string>('OPENAI_MAX_OUTPUT_TOKENS'),
        ),
      },
      ports,
    );
  }

  private buildSystemPrompt(): string {
    return loadSystemPromptFile(this.promptDir, 'discord-chat.system.txt');
  }
}
