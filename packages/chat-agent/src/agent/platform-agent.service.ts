import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CHAT_SYSTEM_PROMPT_CORE,
  LlmAgentService,
  LlmAgentPorts,
  NOOP_METRICS_PORT,
  ToolExecutorPort,
  createEnvLlmExecutionPort,
  type LlmExecutionPort,
  type LlmProviderAdapter,
  loadSystemPromptFile,
} from '@wispace/llm-agent';
import {
  PlatformLlmSafetyEventAdapter,
  PlatformLlmUsageRecorderAdapter,
} from '@wispace/chat-metering';
import {
  errorMessage,
  REDIS_CLIENT,
  type RedisClientPort,
} from '@wispace/bot-common';
import { PlatformChatHistoryService } from '../chat-history/platform-chat-history.service';
import type {
  PlatformAgentInput,
  PlatformAgentOptions,
  PlatformAgentReply,
  PlatformAgentToolContext,
  PlatformToolExecutorPort,
} from './platform-agent.types';
import { pinFactsToReply } from './pinned-facts';

const FEATURE = 'FREE_FORM_CHAT';

// Execution-control defaults — same contract and env keys as the Messenger
// app's `LlmExecutionConfigService`, so all three bots share one documented
// configuration surface (`LLM_EXECUTION_ENABLED`, `LLM_MAX_CONCURRENT`,
// `LLM_GLOBAL_MAX_CONCURRENT`, `LLM_OPENAI_RETRY_MAX_ATTEMPTS`,
// `LLM_OPENAI_RETRY_BACKOFF_MS`, `LLM_REQUEST_TIMEOUT_MS`,
// `LLM_GLOBAL_CONCURRENCY_ENABLED`).
const DEFAULT_MAX_CONCURRENT = 3;
const DEFAULT_GLOBAL_MAX_CONCURRENT = 10;
const DEFAULT_RETRY_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BACKOFF_MS = 2_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Thin NestJS adapter around `@wispace/llm-agent`'s platform-agnostic
 * orchestration loop — shared by Messenger, Discord and Zalo (replaces their
 * near-identical per-app agent services). Usage/safety events persist via
 * `@wispace/chat-metering` (platform set by the app).
 *
 * LLM execution control (concurrency cap, request deadline, retry, optional
 * Redis-distributed global budget) lives in the `llmExecution` port — injected
 * by the app (Messenger uses `LlmExecutionService`) or built from the shared
 * `LLM_EXECUTION_*` env contract. Chat no longer maintains a private,
 * hardcoded limiter/retry path.
 */
@Injectable()
export class PlatformAgentService {
  private readonly logger = new Logger(PlatformAgentService.name);
  private agent?: LlmAgentService<PlatformAgentToolContext>;

  constructor(
    private readonly configService: ConfigService,
    private readonly toolsService: PlatformToolExecutorPort,
    private readonly historyService: PlatformChatHistoryService,
    private readonly usageRecorder: PlatformLlmUsageRecorderAdapter,
    private readonly safetyEventService: PlatformLlmSafetyEventAdapter,
    @Inject('LLM_PROVIDER_ADAPTER')
    private readonly adapter: LlmProviderAdapter,
    private readonly options: PlatformAgentOptions,
    @Optional()
    @Inject(REDIS_CLIENT)
    private readonly redisClient?: RedisClientPort,
  ) {}

  async reply(input: PlatformAgentInput): Promise<PlatformAgentReply> {
    return this.replyInternal(input);
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
      richFollowUps: [],
      linkContext: input.linkContext,
    };

    await this.options.onBeforeReply?.(input);

    const fastReschedule = this.options.tryFastReschedule
      ? await this.options.tryFastReschedule(toolContext, input.userText)
      : null;
    if (fastReschedule) {
      return {
        ...fastReschedule,
        privateDataFetched: false,
        richFollowUps:
          fastReschedule.richFollowUps ?? toolContext.richFollowUps ?? [],
      };
    }

    const history =
      input.history ??
      (await this.historyService.getHistory(input.externalUserId));

    const result = await this.agent.reply(
      {
        externalUserId: input.externalUserId,
        userId: input.userId,
        userText: input.userText,
        systemPrompt: await this.buildSystemPrompt(input),
        history: history as Parameters<
          LlmAgentService<PlatformAgentToolContext>['reply']
        >[0]['history'],
        correlationId: input.correlationId,
        signal: input.signal,
      },
      toolContext,
    );
    // Generic pinned-facts merge (#207 item 6): server-derived facts from
    // tools (e.g. the created exercise URL) are appended deterministically
    // when the model's reply omits them.
    const text = pinFactsToReply(result.text, toolContext.pinnedFacts ?? []);

    if (this.options.appendHistory !== false && input.history === undefined) {
      await this.historyService.appendTurn(
        input.externalUserId,
        input.userText,
        text,
      );
    }

    return {
      text,
      privateDataFetched: toolContext.privateDataFetched === true,
      richFollowUps: toolContext.richFollowUps ?? [],
      exhausted: result.exhausted,
      toolSummary: result.toolSummary,
    };
  }

  private buildAgent(): LlmAgentService<PlatformAgentToolContext> {
    const onToolResult = this.options.onToolResult;
    const toolExecutor: ToolExecutorPort<PlatformAgentToolContext> = {
      execute: (toolName, argsJson, ctx, signal) =>
        this.toolsService
          .execute(toolName, argsJson, ctx, signal)
          .then((result) => {
            if (onToolResult) {
              // Fire-and-forget: a rejecting hook (e.g. profile store down)
              // must never fail the chat — log and move on.
              Promise.resolve(
                onToolResult({ toolName, argsJson, result, context: ctx }),
              ).catch((error: unknown) => {
                this.logger.warn(
                  `onToolResult hook failed tool=${toolName} error=${errorMessage(error)}`,
                );
              });
            }
            return result;
          }),
    };

    const ports: LlmAgentPorts<PlatformAgentToolContext> = {
      // ponytail: shared retry helper from llm-agent (was 3 local copies of sleep+backoff)
      llmExecution:
        this.options.llmExecution ?? this.buildEnvLlmExecutionPort(),
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
        maxLlmRetries: this.options.maxLlmRetries,
        toolExecutionTimeoutMs: this.options.toolExecutionTimeoutMs,
      },
      {
        ...ports,
        metrics: this.options.metrics ?? NOOP_METRICS_PORT,
      },
    );
  }

  /**
   * Default `llmExecution` port for apps that do not inject their own
   * (Messenger injects `LlmExecutionService`). Reads the shared `LLM_EXECUTION_*`
   * contract: enable flag, per-instance concurrency cap, per-request deadline,
   * retry budget, and an optional Redis-distributed aggregate budget.
   */
  private buildEnvLlmExecutionPort(): LlmExecutionPort {
    const globalConcurrencyEnabled =
      process.env.LLM_GLOBAL_CONCURRENCY_ENABLED?.toLowerCase() === 'true';

    return createEnvLlmExecutionPort(
      {
        enabled: this.readEnvBoolean('LLM_EXECUTION_ENABLED', true),
        maxConcurrent: this.readEnvPositiveInt(
          'LLM_MAX_CONCURRENT',
          DEFAULT_MAX_CONCURRENT,
        ),
        globalMaxConcurrent: this.readEnvPositiveInt(
          'LLM_GLOBAL_MAX_CONCURRENT',
          DEFAULT_GLOBAL_MAX_CONCURRENT,
        ),
        maxAttempts: this.readEnvPositiveInt(
          'LLM_OPENAI_RETRY_MAX_ATTEMPTS',
          DEFAULT_RETRY_MAX_ATTEMPTS,
        ),
        baseBackoffMs: this.readEnvPositiveInt(
          'LLM_OPENAI_RETRY_BACKOFF_MS',
          DEFAULT_RETRY_BACKOFF_MS,
        ),
        requestTimeoutMs: this.readEnvPositiveInt(
          'LLM_REQUEST_TIMEOUT_MS',
          DEFAULT_REQUEST_TIMEOUT_MS,
        ),
        globalConcurrencyEnabled,
        redis: globalConcurrencyEnabled
          ? (this.redisClient?.getNativeClient() ?? null)
          : null,
      },
      this.adapter,
      this.logger,
    );
  }

  private readEnvBoolean(key: string, defaultValue: boolean): boolean {
    const raw = this.configService.get<string>(key);
    if (raw === undefined || raw === null) return defaultValue;
    return raw.toLowerCase() === 'true';
  }

  private readEnvPositiveInt(key: string, defaultValue: number): number {
    const raw = this.configService.get<string>(key);
    if (raw === undefined || raw === null) return defaultValue;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0
      ? Math.floor(value)
      : defaultValue;
  }

  private async buildSystemPrompt(input: PlatformAgentInput): Promise<string> {
    const overlay = loadSystemPromptFile(
      this.options.promptDir,
      this.options.promptFile,
    );
    const base = `${CHAT_SYSTEM_PROMPT_CORE}\n\n${overlay}`;
    const suffix = await this.options.systemPromptSuffix?.(input);
    return suffix ? `${base}\n\n${suffix}` : base;
  }
}
