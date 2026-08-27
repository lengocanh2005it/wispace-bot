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
  isAmbiguousMessage,
  isObviouslyOffTopic,
  buildClarificationCancelledMessage,
  buildClarificationUnavailableMessage,
  buildClarificationMessage,
  buildWispaceScopeRedirectMessage,
} from '@wispace/llm-agent';
import {
  PlatformLlmSafetyEventAdapter,
  PlatformLlmUsageRecorderAdapter,
} from '@wispace/chat-metering';
import { errorMessage, maskExternalId } from '@wispace/bot-common/masking';
import { buildUnsupportedMessageTypeReply } from '@wispace/bot-common/messages';
import { REDIS_CLIENT, type RedisClientPort } from '@wispace/bot-common/redis';
import { PlatformChatHistoryService } from '../chat-history/platform-chat-history.service';
import type {
  PlatformAgentInput,
  PlatformAgentOptions,
  PlatformAgentReply,
  PlatformAgentToolContext,
  PlatformToolExecutorPort,
} from './platform-agent.types';
import { pinFactsToReply } from './pinned-facts';
import {
  ClarificationStateMachine,
  RedisClarificationStateStore,
  MemoryClarificationStateStore,
  type ClarificationChoice,
  type ClarificationStateStore,
} from '../clarification/clarification-state';

const FEATURE = 'FREE_FORM_CHAT';

// Execution-control defaults — same contract and env keys as the Messenger
// app's `LlmExecutionConfigService`, so all three bots share one documented
// configuration surface (`LLM_EXECUTION_ENABLED`, `LLM_MAX_CONCURRENT`,
// `LLM_GLOBAL_MAX_CONCURRENT`, `LLM_OPENAI_RETRY_MAX_ATTEMPTS`,
// `LLM_OPENAI_RETRY_BACKOFF_MS`, `LLM_REQUEST_TIMEOUT_MS`,
// `LLM_GLOBAL_CONCURRENCY_ENABLED`).
import { buildLlmExecutionConfig } from '@wispace/llm-agent';

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
  private readonly clarificationMachine = new ClarificationStateMachine();
  private readonly clarificationStore: ClarificationStateStore;

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
  ) {
    if (options.clarificationStore) {
      this.clarificationStore = options.clarificationStore;
    } else if (redisClient?.isConfiguredEnabled?.() === true) {
      this.clarificationStore = new RedisClarificationStateStore(
        redisClient,
        `chat:clarification:${options.platform ?? 'default'}`,
      );
    } else {
      this.clarificationStore = new MemoryClarificationStateStore();
    }
  }

  async reply(input: PlatformAgentInput): Promise<PlatformAgentReply> {
    return this.replyInternal(input);
  }

  async clearClarificationState(externalUserId: string): Promise<void> {
    await this.clarificationStore.clear(this.clarificationKey(externalUserId));
  }

  async markClarificationDeliveryFailedForEvent(
    externalUserId: string,
    eventId?: string,
  ): Promise<void> {
    if (!eventId) return;
    const key = this.clarificationKey(externalUserId);
    const state = await this.clarificationStore.get(key);
    if (state?.lastEventId !== eventId) return;
    await this.clarificationStore.set(
      key,
      {
        ...state,
        version: state.version + 1,
        lastDeliveryFailed: true,
      },
      state.version,
    );
  }

  private async replyInternal(
    input: PlatformAgentInput,
  ): Promise<PlatformAgentReply> {
    if (!this.agent) {
      this.agent = this.buildAgent();
    }

    await this.options.onBeforeReply?.(input);

    if (!/[\p{L}\p{N}]/u.test(input.userText)) {
      this.recordClarificationOutcome('blocked_tool');
      return this.staticReply(buildUnsupportedMessageTypeReply(), input);
    }

    const clarification = await this.handleClarification(input);
    if (clarification.reply) {
      return clarification.reply;
    }
    const effectiveInput = clarification.input ?? input;

    const toolContext: PlatformAgentToolContext = {
      externalUserId: effectiveInput.externalUserId,
      userId: effectiveInput.userId,
      userText: effectiveInput.userText,
      isServerChannel: effectiveInput.isServerChannel,
      privateDataFetched: false,
      richFollowUps: [],
      linkContext: effectiveInput.linkContext,
    };

    const fastReschedule = this.options.tryFastReschedule
      ? await this.options.tryFastReschedule(
          toolContext,
          effectiveInput.userText,
        )
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
      effectiveInput.history ??
      (await this.historyService.getHistory(effectiveInput.externalUserId));

    const result = await this.agent.reply(
      {
        externalUserId: effectiveInput.externalUserId,
        userId: effectiveInput.userId,
        userText: effectiveInput.userText,
        systemPrompt: await this.buildSystemPrompt(effectiveInput),
        history: history as Parameters<
          LlmAgentService<PlatformAgentToolContext>['reply']
        >[0]['history'],
        correlationId: effectiveInput.correlationId,
        signal: effectiveInput.signal,
      },
      toolContext,
    );
    // Generic pinned-facts merge (#207 item 6): server-derived facts from
    // tools (e.g. the created exercise URL) are appended deterministically
    // when the model's reply omits them.
    const text = pinFactsToReply(result.text, toolContext.pinnedFacts ?? []);

    if (
      this.options.appendHistory !== false &&
      effectiveInput.history === undefined
    ) {
      await this.historyService.appendTurn(
        effectiveInput.externalUserId,
        effectiveInput.userText,
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

  private async handleClarification(input: PlatformAgentInput): Promise<{
    input?: PlatformAgentInput;
    reply?: PlatformAgentReply;
  }> {
    const key = this.clarificationKey(input.externalUserId);
    const now = Date.now();

    try {
      let state = await this.clarificationStore.get(key);

      if (
        state &&
        (this.clarificationMachine.isExpired(state, now) ||
          state.userId !== input.userId)
      ) {
        this.recordClarificationOutcome(
          this.clarificationMachine.isExpired(state, now)
            ? 'expired'
            : 'identity_reset',
        );
        const staleCleared = await this.clarificationStore.clear(
          key,
          state.version,
        );
        if (staleCleared === false) {
          throw new Error('Clarification state version conflict');
        }
        state = null;
      }

      if (
        state &&
        input.correlationId &&
        state.lastEventId === input.correlationId &&
        state.lastReplyText &&
        state.lastDeliveryFailed !== true
      ) {
        return {
          reply: this.staticReply(state.lastReplyText, input, true),
        };
      }

      if (this.clarificationMachine.isCancel(input.userText)) {
        const cancelled = await this.clarificationStore.clear(
          key,
          state?.version,
        );
        if (state && cancelled === false) {
          throw new Error('Clarification state version conflict');
        }
        this.recordClarificationOutcome('cancelled');
        return {
          reply: this.staticReply(buildClarificationCancelledMessage(), input),
        };
      }

      const choice = state
        ? this.clarificationMachine.parseChoice(input.userText)
        : null;
      if (state && choice) {
        const consumed = await this.clarificationStore.clear(
          key,
          state.version,
        );
        if (consumed === false) {
          this.recordClarificationOutcome('blocked_tool');
          this.recordClarificationOutcome('replayed');
          return {
            reply: this.staticReply(buildClarificationMessage(), input),
          };
        }
        this.recordClarificationOutcome('choice');
        return {
          input: {
            ...input,
            userText: this.buildChoicePrompt(choice),
          },
        };
      }

      const offTopic = isObviouslyOffTopic(input.userText);
      const ambiguous =
        isAmbiguousMessage(input.userText) ||
        this.clarificationMachine.isContradictory(input.userText);

      if (state && !offTopic && !ambiguous) {
        // Clear a stale clarification before a new clear question reaches any
        // tool path; an agent failure must not preserve old authority.
        const cleared = await this.clarificationStore.clear(key, state.version);
        if (cleared === false) {
          throw new Error('Clarification state version conflict');
        }
        this.recordClarificationOutcome('new_question');
        return { input };
      }

      if (state) {
        const next = this.clarificationMachine.recordIrrelevant(state, now);
        if (next.action === 'clear') {
          this.recordClarificationOutcome('blocked_tool');
          this.recordClarificationOutcome('max_reset');
          const menuText = buildClarificationMessage();
          const cleared = await this.clarificationStore.clear(
            key,
            state.version,
          );
          if (cleared === false) {
            throw new Error('Clarification state version conflict');
          }
          return {
            reply: this.staticReply(menuText, input),
          };
        }
        const replyText = offTopic
          ? buildWispaceScopeRedirectMessage()
          : buildClarificationMessage();
        const nextState = this.clarificationMachine.withReply(
          next.state!,
          input.correlationId,
          replyText,
        );
        const updated = await this.clarificationStore.set(
          key,
          nextState,
          state.version,
        );
        if (updated === false) {
          const replay = await this.clarificationStore.get(key);
          if (
            replay &&
            replay.lastEventId === input.correlationId &&
            replay.lastReplyText
          ) {
            return {
              reply: this.staticReply(replay.lastReplyText, input, true),
            };
          }
          throw new Error('Clarification state version conflict');
        }
        this.recordClarificationOutcome(
          next.action === 'reset_menu' ? 'reset_menu' : 'irrelevant_clarify',
        );
        this.recordClarificationOutcome('blocked_tool');
        return {
          reply: this.staticReply(replyText, input),
        };
      }

      if (offTopic || ambiguous) {
        const replyText = offTopic
          ? buildWispaceScopeRedirectMessage()
          : buildClarificationMessage();
        const startedState = this.clarificationMachine.withReply(
          this.clarificationMachine.start(now, input.userId),
          input.correlationId,
          replyText,
        );
        const started = await this.clarificationStore.set(key, startedState, 0);
        if (started === false) {
          const replay = await this.clarificationStore.get(key);
          if (
            replay &&
            replay.lastEventId === input.correlationId &&
            replay.lastReplyText
          ) {
            return {
              reply: this.staticReply(replay.lastReplyText, input, true),
            };
          }
          throw new Error('Clarification state version conflict');
        }
        this.recordClarificationOutcome(
          offTopic ? 'started_offtopic' : 'started_ambiguous',
        );
        this.recordClarificationOutcome('blocked_tool');
        return {
          reply: this.staticReply(replyText, input),
        };
      }

      return { input };
    } catch (error) {
      this.recordClarificationOutcome('unavailable');
      this.recordClarificationOutcome('blocked_tool');
      this.logger.error(
        `Clarification state unavailable externalUserId=${maskExternalId(input.externalUserId)} error=${errorMessage(error)}`,
      );
      return {
        reply: this.staticReply(buildClarificationUnavailableMessage(), input),
      };
    }
  }

  private recordClarificationOutcome(outcome: string): void {
    try {
      this.options.clarificationOutcomeInc?.(outcome);
    } catch {
      // Metrics must never change chat behavior.
    }
  }

  private staticReply(
    text: string,
    input: PlatformAgentInput,
    skipDelivery = false,
  ): PlatformAgentReply {
    return {
      text,
      privateDataFetched: false,
      richFollowUps: [],
      skipHistory: true,
      clarification: true,
      ...(input.correlationId
        ? {
            deliveryKey: `clarification:${this.options.platform ?? 'default'}:${input.correlationId}`,
          }
        : {}),
      ...(skipDelivery ? { skipDelivery: true } : {}),
    };
  }

  private buildChoicePrompt(choice: ClarificationChoice): string {
    switch (choice) {
      case 'progress':
        return 'Mình muốn xem tiến độ học IELTS của mình.';
      case 'schedule':
        return 'Mình muốn xem lịch học sắp tới của mình.';
      case 'reschedule':
        return 'Mình muốn đổi lịch học.';
    }
  }

  private clarificationKey(externalUserId: string): string {
    return `${this.options.platform ?? 'default'}:${externalUserId}`;
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
    const config = buildLlmExecutionConfig();

    return createEnvLlmExecutionPort(
      {
        ...config,
        redis: config.globalConcurrencyEnabled
          ? (this.redisClient?.getNativeClient() ?? null)
          : null,
      },
      this.adapter,
      this.logger,
      this.options.llmAdmissionMetrics,
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
