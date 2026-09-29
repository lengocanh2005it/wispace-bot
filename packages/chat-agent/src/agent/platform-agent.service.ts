import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CHAT_SYSTEM_PROMPT_CORE,
  DEFAULT_TOOL_EXECUTION_TIMEOUT_MS,
  LlmAgentService,
  NOOP_METRICS_PORT,
  composeChatSystemPrompt,
  loadSystemPromptFile,
  IntentDetector,
  isGreetingOnly,
  isObviouslyOffTopic,
  buildPromptInjectionBlockedMessage,
  CHAT_FAILURE_FALLBACK_MESSAGE,
  buildHostilityDeflectionMessage,
  buildCrisisSupportHandoffMessage,
  buildNonDisclosureReply,
  isExtractionReason,
  detectPromptInjection,
  detectPromptInjectionAcrossTurns,
  sanitizeUntrustedTextForLlm,
  buildLlmExecutionConfig,
  generatePromptCanary,
  type LlmAgentPorts,
  type ToolExecutorPort,
  type LlmProviderAdapter,
  type LlmAgentPromptParts,
  type ClassifyResult,
  type LlmDegradedAction,
  type LlmDegradedFailureClass,
  type LlmDegradedModeEvent,
  type ClassifierOutcomeLabel,
  type LlmExecutionPort,
} from '@wispace/llm-agent/core';
import { createEnvLlmExecutionPort } from '@wispace/llm-agent/adapters';
import {
  PlatformLlmSafetyEventAdapter,
  PlatformLlmUsageRecorderAdapter,
} from '@wispace/chat-metering/adapters';
import {
  errorMessage,
  maskExternalId,
  maskExternalIdInText,
  sanitizeLogValue,
} from '@wispace/bot-common/masking';
import { buildUnsupportedMessageTypeReply } from '@wispace/bot-common/messages';
import { REDIS_CLIENT, type RedisClientPort } from '@wispace/bot-common/redis';
import { isAbortError } from '@wispace/bot-common/utils';
import {
  RESCHEDULE_CANCELLED_MESSAGE,
  RESCHEDULE_CANCEL_PROCESSING_MESSAGE,
  RESCHEDULE_EXPIRED_MESSAGE,
} from '@wispace/reschedule-confirm/core';
import type { RescheduleCancellationOutcome } from '@wispace/reschedule-confirm/core';
import { PlatformChatHistoryService } from '../chat-history/platform-chat-history.service';
import type {
  PlatformAgentInput,
  PlatformAgentOptions,
  PlatformAgentReply,
  PlatformAgentToolContext,
  PlatformToolExecutorPort,
} from './platform-agent.types';
import { redactPromptPart } from './system-prompt-parts';
import { pinFactsToReply } from './pinned-facts';
import {
  clarificationStateKey,
  type ClarificationStateStore,
  createClarificationStateStore,
  readClarificationLimits,
} from '../clarification/clarification-state';
import {
  ClarificationResponder,
  type ClarificationStoreFailure,
} from '../clarification/clarification-responder';
import type { ClarificationChoice } from '../clarification/clarification-text';

const FEATURE = 'FREE_FORM_CHAT';

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
  /** #649 — belt-and-braces: greeting/self-intro are normally filtered at the
   *  bot gateway, but the classifier still checks so it never runs on them. */
  private readonly intentDetector = new IntentDetector();
  private readonly identityVersions = new Map<string, string>();
  private readonly clarificationStore: ClarificationStateStore;
  private readonly clarificationResponder: ClarificationResponder;
  private readonly promptCanary: string;

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
    this.promptCanary = generatePromptCanary();
    if (options.clarificationStore) {
      this.clarificationStore = options.clarificationStore;
    } else {
      this.clarificationStore = createClarificationStateStore({
        platform: options.platform ?? 'default',
        redisClient,
      });
    }
    this.clarificationResponder = new ClarificationResponder({
      platform: options.platform ?? 'default',
      store: this.clarificationStore,
      limits: readClarificationLimits(configService),
      // #1143 — the outcome names are the responder's vocabulary; turning one
      // into a metric is a pipeline concern and stays here.
      outcomeInc: (outcome) => this.recordClarificationOutcome(outcome),
      onStoreUnavailable: (failure) =>
        this.recordClarificationUnavailable(failure),
    });
    // Validate bounded LLM execution configuration during startup even though
    // the agent itself is built lazily on the first normal chat request.
    buildLlmExecutionConfig();

    if (this.classifierEnabled && !this.options.contentClassifier) {
      throw new Error(
        `LLM_INPUT_CLASSIFIER_ENABLED=true is configured for platform "${this.options.platform}", but no contentClassifier was provided to PlatformAgentService. Startup aborted to prevent silent unclassified execution (#864, #868).`,
      );
    }
  }

  async reply(input: PlatformAgentInput): Promise<PlatformAgentReply> {
    return this.replyInternal(input);
  }

  async clearClarificationState(externalUserId: string): Promise<void> {
    await this.clarificationStore.clear(
      clarificationStateKey(this.options.platform ?? 'default', externalUserId),
    );
  }

  async cancelPendingReschedule(
    externalUserId: string,
    approvalToken?: string,
  ): Promise<RescheduleCancellationOutcome> {
    return (
      (await this.options.cancelPendingReschedule?.(
        externalUserId,
        approvalToken,
      )) ?? 'none'
    );
  }

  async markClarificationDeliveryFailedForEvent(
    externalUserId: string,
    eventId?: string,
  ): Promise<void> {
    await this.clarificationResponder.markDeliveryFailed(
      externalUserId,
      eventId,
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
    const classifierBlock = clarification.choiceConsumed
      ? null
      : await this.runInputClassifier(effectiveInput);
    if (classifierBlock) {
      return classifierBlock;
    }

    const identity = await this.resolveCurrentIdentity(effectiveInput);
    const identityChanged = identity
      ? this.rememberIdentityVersion(
          effectiveInput.externalUserId,
          identity.mappingVersion,
        )
      : this.forgetIdentityVersion(effectiveInput.externalUserId);
    if (!identity) {
      // Fail closed: never feed turns belonging to a revoked/unknown mapping
      // back to the model. This also clears the memory backend, not only Redis.
      await this.historyService
        .clear(effectiveInput.externalUserId)
        .catch(() => undefined);
    } else if (identityChanged) {
      // A queued pipeline turn may carry history read before a relink/revoke.
      // Never let that snapshot cross an ownership generation boundary.
      await this.historyService
        .clear(effectiveInput.externalUserId)
        .catch(() => undefined);
    }
    const resolvedInput = identity
      ? {
          ...effectiveInput,
          userId: identity.userId,
          mappingVersion: identity.mappingVersion,
        }
      : { ...effectiveInput, userId: undefined, mappingVersion: undefined };

    const toolContext: PlatformAgentToolContext = {
      externalUserId: resolvedInput.externalUserId,
      userId: resolvedInput.userId,
      mappingVersion: resolvedInput.mappingVersion,
      identityVerified: !!identity,
      userText: resolvedInput.userText,
      isServerChannel: resolvedInput.isServerChannel,
      privateDataFetched: false,
      richFollowUps: [],
      linkContext: effectiveInput.linkContext,
    };

    let fastReschedule: PlatformAgentReply | null = null;
    try {
      fastReschedule = this.options.tryFastReschedule
        ? await this.options.tryFastReschedule(
            toolContext,
            resolvedInput.userText,
            resolvedInput.signal
              ? AbortSignal.any([
                  resolvedInput.signal,
                  AbortSignal.timeout(
                    this.options.toolExecutionTimeoutMs ??
                      DEFAULT_TOOL_EXECUTION_TIMEOUT_MS,
                  ),
                ])
              : AbortSignal.timeout(
                  this.options.toolExecutionTimeoutMs ??
                    DEFAULT_TOOL_EXECUTION_TIMEOUT_MS,
                ),
          )
        : null;
    } catch (error) {
      if (resolvedInput.signal?.aborted || isAbortError(error)) {
        return this.abortedReply();
      }
      throw error;
    }
    if (fastReschedule) {
      return {
        ...fastReschedule,
        privateDataFetched: false,
        richFollowUps:
          fastReschedule.richFollowUps ?? toolContext.richFollowUps ?? [],
      };
    }

    let history = identity ? effectiveInput.history : [];
    if (identity && (identityChanged || effectiveInput.history === undefined)) {
      try {
        history = await this.historyService.getHistory(
          resolvedInput.externalUserId,
        );
      } catch (error) {
        this.recordDegraded(
          effectiveInput,
          'history_unavailable',
          'chat_fallback',
        );
        throw error;
      }
    }

    let result: Awaited<
      ReturnType<LlmAgentService<PlatformAgentToolContext>['reply']>
    >;
    try {
      const prompt = await this.buildSystemPrompt(resolvedInput);
      result = await this.agent.reply(
        {
          externalUserId: resolvedInput.externalUserId,
          userId: resolvedInput.userId,
          userText: resolvedInput.userText,
          userTextParts: resolvedInput.userTextParts,
          systemPrompt: prompt.systemPrompt,
          systemPromptParts: prompt.systemPromptParts,
          history: history as Parameters<
            LlmAgentService<PlatformAgentToolContext>['reply']
          >[0]['history'],
          correlationId: resolvedInput.correlationId,
          signal: resolvedInput.signal,
        },
        toolContext,
      );
    } catch (error) {
      if (resolvedInput.signal?.aborted || isAbortError(error)) {
        return this.abortedReply();
      }
      throw error;
    }
    // Generic pinned-facts merge (#207 item 6): server-derived facts from
    // tools (e.g. the created exercise URL) are appended deterministically
    // when the model's reply omits them.
    const text = pinFactsToReply(result.text, toolContext.pinnedFacts ?? []);

    if (
      this.options.appendHistory !== false &&
      resolvedInput.history === undefined &&
      result.skipHistory !== true
    ) {
      try {
        await this.historyService.appendTurn(
          resolvedInput.externalUserId,
          resolvedInput.userText,
          text,
        );
      } catch (error) {
        this.recordDegraded(
          effectiveInput,
          'history_unavailable',
          'chat_fallback',
        );
        throw error;
      }
    }

    return {
      text,
      privateDataFetched: toolContext.privateDataFetched === true,
      richFollowUps: toolContext.richFollowUps ?? [],
      exhausted: result.exhausted,
      toolSummary: result.toolSummary,
      skipHistory: result.skipHistory,
    };
  }

  private async resolveCurrentIdentity(input: PlatformAgentInput) {
    const provider = this.options.currentIdentityProvider;
    if (typeof provider !== 'function') return undefined;
    try {
      const identity = await provider(input.externalUserId);
      if (
        !identity ||
        !Number.isInteger(identity.userId) ||
        identity.userId <= 0 ||
        typeof identity.mappingVersion !== 'string' ||
        !identity.mappingVersion.trim()
      ) {
        this.logger.warn(
          `Current-mapping lookup returned invalid identity for ${maskExternalId(input.externalUserId)}`,
        );
        return undefined;
      }
      return identity;
    } catch (error) {
      const safeError = maskExternalIdInText(
        sanitizeUntrustedTextForLlm(errorMessage(error), {
          maxChars: 500,
          unsafePlaceholder: 'Current-mapping lookup failed',
        }).text,
        input.externalUserId,
      );
      this.logger.warn(
        `Current-mapping lookup failed for ${maskExternalId(input.externalUserId)}: ${safeError}`,
      );
      return undefined;
    }
  }

  private rememberIdentityVersion(
    externalUserId: string,
    mappingVersion: string,
  ): boolean {
    const previous = this.identityVersions.get(externalUserId);
    this.identityVersions.delete(externalUserId);
    this.identityVersions.set(externalUserId, mappingVersion);
    while (this.identityVersions.size > 10_000) {
      const oldest = this.identityVersions.keys().next().value;
      if (oldest === undefined) break;
      this.identityVersions.delete(oldest);
    }
    return previous !== undefined && previous !== mappingVersion;
  }

  private forgetIdentityVersion(externalUserId: string): boolean {
    const hadIdentity = this.identityVersions.delete(externalUserId);
    return hadIdentity;
  }

  /**
   * One clarification turn. The responder owns the state, the version and the
   * compare-and-set (#1143); this keeps only the pipeline's position — where a
   * decision becomes a reply, where an accepted choice becomes a rewritten
   * input, and which turn the input classifier must not run on.
   */
  private async handleClarification(input: PlatformAgentInput): Promise<{
    input?: PlatformAgentInput;
    reply?: PlatformAgentReply;
    /** #649 — the message was a clarification-menu choice, rewritten to a
     *  canned prompt; the input classifier must not run on it. */
    choiceConsumed?: boolean;
  }> {
    const turn = await this.clarificationResponder.handle({
      externalUserId: input.externalUserId,
      userText: input.userText,
      ...(input.userId === undefined ? {} : { userId: input.userId }),
      ...(input.correlationId === undefined
        ? {}
        : { eventId: input.correlationId }),
      // #959: the stop and cancel acknowledgements cancel a staged reschedule
      // first. That call belongs to the pipeline, so the resolver is supplied
      // here rather than reached for inside the state modules.
      resolveStopReply: (fallback) =>
        this.stopReply(input.externalUserId, fallback),
    });

    if (turn.kind === 'reply') {
      return { reply: this.staticReply(turn.text, input, turn.skipDelivery) };
    }
    if (turn.choice) {
      return {
        input: {
          ...input,
          userText: this.buildChoicePrompt(turn.choice),
          userTextParts: undefined,
        },
        choiceConsumed: true,
      };
    }
    return { input };
  }

  private recordClarificationOutcome(outcome: string): void {
    try {
      this.options.clarificationOutcomeInc?.(outcome);
    } catch {
      // Metrics must never change chat behavior.
    }
  }

  /**
   * A store outage still fails closed. The responder hands the raw failure up
   * rather than logging it, so the masked line and the degraded-mode event —
   * the pipeline's own telemetry — are recorded here (#1143).
   */
  private recordClarificationUnavailable(
    failure: ClarificationStoreFailure,
  ): void {
    this.recordDegraded(
      {
        externalUserId: failure.externalUserId,
        correlationId: failure.eventId,
      },
      'history_unavailable',
      'block_response',
    );
    this.logger.error(
      `Clarification state unavailable externalUserId=${maskExternalId(failure.externalUserId)} error=${errorMessage(failure.error, failure.externalUserId)}`,
    );
  }

  private recordDegraded(
    turn: { externalUserId: string; correlationId?: string },
    failureClass: LlmDegradedFailureClass,
    action: LlmDegradedAction,
  ): void {
    const event: LlmDegradedModeEvent = {
      platform: this.options.platform ?? 'unknown',
      feature: FEATURE,
      failureClass,
      action,
      ...(turn.correlationId ? { correlationId: turn.correlationId } : {}),
    };
    try {
      this.options.metrics?.degradedModeInc?.(event);
    } catch {
      // Telemetry must never change the fail-closed history policy.
    }
    const correlation = turn.correlationId
      ? maskExternalIdInText(
          sanitizeLogValue(turn.correlationId, 120),
          turn.externalUserId,
        )
      : 'n/a';
    this.logger.warn(
      `Chat degraded platform=${event.platform} feature=${FEATURE} failure_class=${failureClass} action=${action} correlation=${correlation} externalUserId=${maskExternalId(turn.externalUserId)}`,
    );
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

  private async stopReply(
    externalUserId: string,
    fallbackMessage: string,
  ): Promise<string> {
    try {
      const outcome =
        await this.options.cancelPendingReschedule?.(externalUserId);
      if (outcome === 'cancelled') {
        return RESCHEDULE_CANCELLED_MESSAGE;
      }
      if (outcome === 'processing') {
        return RESCHEDULE_CANCEL_PROCESSING_MESSAGE;
      }
      if (outcome === 'expired') {
        return RESCHEDULE_EXPIRED_MESSAGE;
      }
    } catch (error) {
      this.logger.warn(
        `Reschedule stop cleanup failed externalUserId=${maskExternalId(
          externalUserId,
        )}: ${sanitizeLogValue(errorMessage(error), 200)}`,
      );
    }
    return fallbackMessage;
  }

  /** A cancelled turn is consumed without producing fallback or history. */
  private abortedReply(): PlatformAgentReply {
    return {
      text: '',
      privateDataFetched: false,
      richFollowUps: [],
      skipHistory: true,
      clarification: true,
      skipDelivery: true,
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
      platform: this.options.platform,
      // ponytail: shared retry helper from llm-agent (was 3 local copies of sleep+backoff)
      llmExecution:
        this.options.llmExecution ?? this.buildEnvLlmExecutionPort(),
      usageRecorder: {
        recordFromCompletion: (params) =>
          this.usageRecorder.recordFromCompletion({
            feature: FEATURE,
            externalUserId: params.externalUserId,
            userId: params.userId,
            provider: params.provider,
            model: params.model,
            response: params.response,
            correlationId: params.correlationId,
            toolRound: params.toolRound,
            status: params.status,
            errorMessage: params.errorMessage,
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
        recordInjectionEvent: (params) =>
          this.safetyEventService.recordInjectionEvent({
            externalUserId: params.externalUserId,
            userId: params.userId,
            correlationId: params.correlationId,
            source: params.source,
            reason: params.reason,
            textPreview: params.textPreview,
            toolName: params.toolName,
          }),
        recordHarmfulOutputBlocked: (params) =>
          this.safetyEventService.recordHarmfulOutputBlocked({
            externalUserId: params.externalUserId,
            userId: params.userId,
            correlationId: params.correlationId,
            reason: params.reason,
            assistantTextPreview: params.assistantTextPreview,
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
        staleObservationRounds: Number(
          this.configService.get<string>('OPENAI_STALE_OBSERVATION_ROUNDS'),
        ),
        maxContextChars: Number(
          this.configService.get<string>('OPENAI_MAX_CONTEXT_CHARS'),
        ),
        maxOutputTokens: Number(
          this.configService.get<string>('OPENAI_MAX_OUTPUT_TOKENS'),
        ),
        maxTotalProviderAttempts:
          buildLlmExecutionConfig().maxTotalProviderAttempts,
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
    // Execution-control defaults — same contract and env keys as the Messenger
    // app's `LlmExecutionConfigService`, so all three bots share one documented
    // configuration surface (`LLM_EXECUTION_ENABLED`, `LLM_MAX_CONCURRENT`,
    // `LLM_GLOBAL_MAX_CONCURRENT`, `LLM_OPENAI_RETRY_MAX_ATTEMPTS`,
    // `LLM_OPENAI_RETRY_BACKOFF_MS`, `LLM_REQUEST_TIMEOUT_MS`,
    // `LLM_GLOBAL_CONCURRENCY_ENABLED`).
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

  private get classifierEnabled(): boolean {
    return this.readEnvBoolean('LLM_INPUT_CLASSIFIER_ENABLED', false);
  }
  private get classifierEnforce(): boolean {
    return this.readEnvBoolean('LLM_INPUT_CLASSIFIER_ENFORCE', false);
  }
  private get classifierMinConfidence(): number {
    const raw = Number(
      this.configService.get<string>('LLM_INPUT_CLASSIFIER_MIN_CONFIDENCE'),
    );
    return Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
  }

  private shortCircuitReply(text: string): PlatformAgentReply {
    return {
      text,
      privateDataFetched: false,
      richFollowUps: [],
      skipHistory: true,
    };
  }

  private blockedReply(text: string): PlatformAgentReply {
    return this.shortCircuitReply(text);
  }

  private async runInputClassifier(
    input: PlatformAgentInput,
  ): Promise<PlatformAgentReply | null> {
    const classifier = this.options.contentClassifier;
    if (!classifier || !this.classifierEnabled) return null;
    // Tier-1 is authoritative. Reuse the shared detectors before admitting
    // tier-2 so a known injection never produces a misleading SAFE verdict or
    // spends a classifier provider call. LlmAgentService repeats the checks as
    // the final guard before any main-model call.
    if (
      detectPromptInjection(input.userText).isInjection ||
      detectPromptInjectionAcrossTurns(
        input.userText,
        input.userTextParts,
        input.history,
        input.userText.length,
      ).isInjection
    ) {
      return null;
    }
    // Skip conditions (#649, #1048, #1054). Greeting / self-intro / off-topic / clarification
    // are normally consumed upstream (bot gateway `IntentDetector`, then
    // `handleClarification`); the checks here make that a guarantee, not an
    // assumption. Distress expressions reach the classifier so that crisis
    // disclosures using distress phrasing are observed (#1048, #1054).
    if (
      isGreetingOnly(input.userText) ||
      isObviouslyOffTopic(input.userText) ||
      this.intentDetector.detect(input.userText).intent !== 'unknown'
    ) {
      return null;
    }

    const mode: 'shadow' | 'enforce' = this.classifierEnforce
      ? 'enforce'
      : 'shadow';
    try {
      const result = await classifier.classify(
        input.userText,
        input.correlationId,
        input.signal,
      );
      if (!result.ok) {
        return this.handleClassifierUnavailable(input, mode, result);
      }
      this.recordClassifierUsage(input, result);
      const { label, confidence, reason } = result.verdict;
      this.recordClassifierVerdictMetric(label, mode);
      if (label === 'SAFE') return null;

      try {
        this.safetyEventService.recordClassifierVerdict({
          externalUserId: input.externalUserId,
          userId: input.userId,
          correlationId: input.correlationId,
          label,
          mode,
          confidence,
          reason,
          textPreview: input.userText,
        });
      } catch {
        // Safety telemetry is best effort; it must not change the verdict path.
      }

      if (mode === 'shadow') return null;

      if (label === 'CRISIS') {
        return this.shortCircuitReply(buildCrisisSupportHandoffMessage());
      }
      if (confidence < this.classifierMinConfidence) return null;
      if (label === 'ABUSE') {
        return this.shortCircuitReply(buildHostilityDeflectionMessage());
      }

      // Extraction-flavoured injection routes to the same non-disclosure line
      // as a probe — a distinct "blocked" reply would itself be an oracle
      // (#625). The classifier prompt emits `reason: "extraction"` for this.
      const text =
        label === 'DISCLOSURE_PROBE' || isExtractionReason(reason)
          ? buildNonDisclosureReply()
          : buildPromptInjectionBlockedMessage();
      return this.blockedReply(text);
    } catch {
      this.logger.warn(
        `Input classifier failed externalUserId=${maskExternalId(input.externalUserId)}`,
      );
      return this.handleClassifierUnavailable(input, mode, {
        ok: false,
        reason: 'error',
      });
    }
  }

  private handleClassifierUnavailable(
    input: PlatformAgentInput,
    mode: 'shadow' | 'enforce',
    result: Extract<ClassifyResult, { ok: false }>,
  ): PlatformAgentReply | null {
    this.recordClassifierVerdictMetric(result.reason, mode);
    this.recordClassifierUsage(input, result);
    if (mode !== 'enforce') return null;
    this.recordDegraded(input, 'classifier_unavailable', 'block_response');
    return this.shortCircuitReply(CHAT_FAILURE_FALLBACK_MESSAGE);
  }

  private recordClassifierVerdictMetric(
    label: ClassifierOutcomeLabel,
    mode: 'shadow' | 'enforce',
  ): void {
    try {
      this.options.metrics?.classifierVerdictInc?.(label, mode);
    } catch {
      // Metrics are best effort and must not change the classifier policy.
    }
  }

  private recordClassifierUsage(
    input: PlatformAgentInput,
    result: ClassifyResult,
  ): void {
    if (
      !result.ok &&
      (result.reason === 'skipped_circuit_open' ||
        result.reason === 'execution_disabled')
    ) {
      return;
    }
    const completion = result.completion;
    const fallback = this.options.classifierUsage;
    try {
      this.usageRecorder.recordFromCompletion({
        feature: 'LLM_INPUT_CLASSIFIER',
        externalUserId: input.externalUserId,
        userId: input.userId,
        provider:
          completion?.provider ??
          fallback?.provider ??
          this.adapter.providerName,
        model:
          completion?.model ??
          fallback?.model ??
          this.adapter.getDefaultModel?.() ??
          'unknown',
        response: {
          id: completion?.responseId ?? '',
          usage: completion?.usage ?? null,
        },
        correlationId: input.correlationId,
        toolRound: 0,
        status: result.ok ? 'ok' : 'error',
        ...(result.ok ? {} : { errorMessage: result.reason }),
      });
    } catch {
      // Usage telemetry is best effort and must never change chat behavior.
    }
  }

  private async buildSystemPrompt(input: PlatformAgentInput): Promise<{
    systemPrompt: string;
    systemPromptParts: LlmAgentPromptParts;
  }> {
    const overlay = loadSystemPromptFile(
      this.options.promptDir,
      this.options.promptFile,
    );
    // Shared composer (#646) — the eval harness composes through the same
    // function, so the two paths cannot drift apart. Dynamic parts carry
    // user-controlled data (display name, profile facts) — the no-secrets
    // invariant (#632) applies at this single consumption point, so every
    // current and future suffix builder inherits it.
    const suffix = await this.options.systemPromptSuffix?.(input);
    const systemPromptParts: LlmAgentPromptParts = {
      core: CHAT_SYSTEM_PROMPT_CORE,
      overlay,
      promptCanary: this.promptCanary,
    };
    if (typeof suffix === 'string') {
      systemPromptParts.identityDisplayName = redactPromptPart(suffix);
    } else {
      systemPromptParts.identityDisplayName = redactPromptPart(
        suffix?.identityDisplayName,
      );
      systemPromptParts.learnerProfile = redactPromptPart(
        suffix?.learnerProfile,
      );
    }
    return {
      systemPrompt: composeChatSystemPrompt(systemPromptParts),
      systemPromptParts,
    };
  }
}
