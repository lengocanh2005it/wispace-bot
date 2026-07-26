import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  LlmAgentService,
  LlmAgentPorts,
  NOOP_METRICS_PORT,
  ToolExecutorPort,
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
import { DiscordLlmUsageRecorderService } from '../../../chat-metering/application/services/discord-llm-usage-recorder.service';
import { DiscordLlmSafetyEventService } from '../../../chat-metering/application/services/discord-llm-safety-event.service';

const FEATURE = 'FREE_FORM_CHAT';

const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_BACKOFF_MS = 500;
const DEFAULT_MAX_CONCURRENT = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
    private readonly usageRecorder: DiscordLlmUsageRecorderService,
    private readonly safetyEventService: DiscordLlmSafetyEventService,
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
      llmExecution: {
        run: (fn) => this.runWithRetry(fn),
      },
      usageRecorder: {
        recordFromCompletion: (params) =>
          this.usageRecorder.recordFromCompletion({
            feature: FEATURE,
            discordUserId: params.externalUserId,
            userId: params.userId,
            model: params.model,
            response: params.response as Parameters<
              DiscordLlmUsageRecorderService['recordFromCompletion']
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

  private async runWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;

        if (
          !this.adapter.isRetryableError(error) ||
          attempt >= RETRY_MAX_ATTEMPTS
        ) {
          throw error;
        }

        const backoffMs = RETRY_BASE_BACKOFF_MS * attempt;
        this.logger.warn(
          `LLM provider retry attempt=${attempt}/${RETRY_MAX_ATTEMPTS} backoffMs=${backoffMs}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        await sleep(backoffMs);
      }
    }

    throw lastError;
  }

  private buildSystemPrompt(): string {
    return loadSystemPromptFile(this.promptDir, 'discord-chat.system.txt');
  }
}
