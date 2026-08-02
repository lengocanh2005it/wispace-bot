import { Inject, Injectable, Logger } from '@nestjs/common';
import { join } from 'path';
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
import type {
  ZaloAgentInput,
  ZaloAgentReply,
  ZaloAgentToolContext,
} from '../../domain/entities/zalo-chat.types';
import { ZaloAgentToolsService } from './zalo-agent-tools.service';
import { ZaloChatHistoryService } from '../services/zalo-chat-history.service';
import { ZaloLlmUsageRecorderService } from '../services/zalo-llm-usage-recorder.service';
import { ZaloLlmSafetyEventService } from '../services/zalo-llm-safety-event.service';

const FEATURE = 'FREE_FORM_CHAT';
const DEFAULT_MAX_CONCURRENT = 3;

/**
 * Thin NestJS adapter around @wispace/llm-agent's platform-agnostic
 * orchestration loop — Zalo counterpart to DiscordAgentService/
 * MessengerAgentService. Includes p-limit concurrency cap to prevent
 * overwhelming the LLM provider.
 */
@Injectable()
export class ZaloAgentService {
  private readonly logger = new Logger(ZaloAgentService.name);
  private readonly promptDir = join(__dirname, '../../../../shared/prompts');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly limiter: (fn: () => Promise<any>) => Promise<any>;
  private agent?: LlmAgentService<ZaloAgentToolContext>;

  constructor(
    private readonly configService: ConfigService,
    private readonly toolsService: ZaloAgentToolsService,
    private readonly historyService: ZaloChatHistoryService,
    private readonly usageRecorder: ZaloLlmUsageRecorderService,
    private readonly safetyEventService: ZaloLlmSafetyEventService,
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

  async reply(input: ZaloAgentInput): Promise<ZaloAgentReply> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return this.limiter(() => this.replyInternal(input));
  }

  private async replyInternal(input: ZaloAgentInput): Promise<ZaloAgentReply> {
    if (!this.agent) {
      this.agent = this.buildAgent();
    }

    const toolContext: ZaloAgentToolContext = {
      zaloUserId: input.zaloUserId,
      userId: input.userId,
    };

    const history = await this.historyService.getHistory(input.zaloUserId);

    const result = await this.agent.reply(
      {
        externalUserId: input.zaloUserId,
        userId: input.userId,
        userText: input.userText,
        systemPrompt: this.buildSystemPrompt(),
        history,
        correlationId: input.correlationId,
      },
      toolContext,
    );

    await this.historyService.appendTurn(
      input.zaloUserId,
      input.userText,
      result.text,
    );

    return { text: result.text };
  }

  private buildAgent(): LlmAgentService<ZaloAgentToolContext> {
    const toolExecutor: ToolExecutorPort<ZaloAgentToolContext> = {
      execute: (toolName, argsJson, ctx) =>
        this.toolsService.execute(toolName, argsJson, ctx),
    };

    const ports: LlmAgentPorts<ZaloAgentToolContext> = {
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
            zaloUserId: params.externalUserId,
            userId: params.userId,
            model: params.model,
            response: params.response as Parameters<
              ZaloLlmUsageRecorderService['recordFromCompletion']
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

    return new LlmAgentService<ZaloAgentToolContext>(
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
    return loadSystemPromptFile(this.promptDir, 'zalo-chat.system.txt');
  }
}
