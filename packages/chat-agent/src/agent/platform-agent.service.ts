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
import {
  PlatformLlmSafetyEventAdapter,
  PlatformLlmUsageRecorderAdapter,
} from '@wispace/chat-metering';
import { PlatformChatHistoryService } from '../chat-history/platform-chat-history.service';
import { PlatformAgentToolsService } from './platform-agent-tools.service';
import type {
  PlatformAgentInput,
  PlatformAgentOptions,
  PlatformAgentReply,
  PlatformAgentToolContext,
} from './platform-agent.types';

const FEATURE = 'FREE_FORM_CHAT';

const DEFAULT_MAX_CONCURRENT = 3;

/**
 * Thin NestJS adapter around `@wispace/llm-agent`'s platform-agnostic
 * orchestration loop — shared by Discord and Zalo (replaces their
 * near-identical per-app agent services). Usage/safety events persist via
 * `@wispace/chat-metering` (platform set by the app). Includes p-limit
 * concurrency cap to prevent overwhelming the LLM provider.
 */
@Injectable()
export class PlatformAgentService {
  private readonly logger = new Logger(PlatformAgentService.name);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly limiter: (fn: () => Promise<any>) => Promise<any>;
  private agent?: LlmAgentService<PlatformAgentToolContext>;

  constructor(
    private readonly configService: ConfigService,
    private readonly toolsService: PlatformAgentToolsService,
    private readonly historyService: PlatformChatHistoryService,
    private readonly usageRecorder: PlatformLlmUsageRecorderAdapter,
    private readonly safetyEventService: PlatformLlmSafetyEventAdapter,
    @Inject('LLM_PROVIDER_ADAPTER')
    private readonly adapter: LlmProviderAdapter,
    private readonly options: PlatformAgentOptions,
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

  async reply(input: PlatformAgentInput): Promise<PlatformAgentReply> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return this.limiter(() => this.replyInternal(input));
  }

  private async replyInternal(
    input: PlatformAgentInput,
  ): Promise<PlatformAgentReply> {
    if (!this.agent) {
      this.agent = this.buildAgent();
    }

    const toolContext: PlatformAgentToolContext = {
      externalUserId: input.externalUserId,
      userId: input.userId,
      isServerChannel: input.isServerChannel,
      privateDataFetched: false,
    };

    const history = await this.historyService.getHistory(input.externalUserId);

    const result = await this.agent.reply(
      {
        externalUserId: input.externalUserId,
        userId: input.userId,
        userText: input.userText,
        systemPrompt: this.buildSystemPrompt(),
        history,
        correlationId: input.correlationId,
      },
      toolContext,
    );

    await this.historyService.appendTurn(
      input.externalUserId,
      input.userText,
      result.text,
    );

    return {
      text: result.text,
      privateDataFetched: toolContext.privateDataFetched === true,
    };
  }

  private buildAgent(): LlmAgentService<PlatformAgentToolContext> {
    const toolExecutor: ToolExecutorPort<PlatformAgentToolContext> = {
      execute: (toolName, argsJson, ctx) =>
        this.toolsService.execute(toolName, argsJson, ctx),
    };

    const ports: LlmAgentPorts<PlatformAgentToolContext> = {
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

    return new LlmAgentService<PlatformAgentToolContext>(
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
    return loadSystemPromptFile(
      this.options.promptDir,
      this.options.promptFile,
    );
  }
}
