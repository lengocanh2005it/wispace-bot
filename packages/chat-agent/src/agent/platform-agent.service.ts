import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CHAT_SYSTEM_PROMPT_CORE,
  DEFAULT_TOOL_EXECUTION_TIMEOUT_MS,
  LlmAgentService,
  LlmAgentPorts,
  NOOP_METRICS_PORT,
  ToolExecutorPort,
  composeChatSystemPrompt,
  createEnvLlmExecutionPort,
  type LlmExecutionPort,
  type LlmProviderAdapter,
  type LlmAgentPromptParts,
  type ClassifyResult,
  loadSystemPromptFile,
  IntentDetector,
  isAmbiguousMessage,
  isStopIntent,
  isGreetingOnly,
  isObviouslyOffTopic,
  buildClarificationCancelledMessage,
  buildStopAcknowledgedMessage,
  buildClarificationUnavailableMessage,
  buildClarificationMessage,
  buildWispaceScopeRedirectMessage,
  buildPromptInjectionBlockedMessage,
  CHAT_FAILURE_FALLBACK_MESSAGE,
  buildHostilityDeflectionMessage,
  buildCrisisSupportHandoffMessage,
  buildNonDisclosureReply,
  isExtractionReason,
  redactSecrets,
  sanitizeUntrustedTextForLlm,
  type LlmDegradedAction,
  type LlmDegradedFailureClass,
  type LlmDegradedModeEvent,
  buildLlmExecutionConfig,
} from '@wispace/llm-agent';
import {
  PlatformLlmSafetyEventAdapter,
  PlatformLlmUsageRecorderAdapter,
} from '@wispace/chat-metering';
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
  type RescheduleCancellationOutcome,
} from '@wispace/reschedule-confirm';
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
  type ClarificationChoice,
  type ClarificationStateStore,
  createClarificationStateStore,
  readClarificationLimits,
} from '../clarification/clarification-state';

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
  private readonly clarificationMachine: ClarificationStateMachine;
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
    const limits = readClarificationLimits(configService);
    this.clarificationMachine = new ClarificationStateMachine(limits);
    if (options.clarificationStore) {
      this.clarificationStore = options.clarificationStore;
    } else {
      this.clarificationStore = createClarificationStateStore({
        platform: options.platform ?? 'default',
        config: configService,
        redisClient,
      });
    }
    // Validate bounded LLM execution configuration during startup even though
    // the agent itself is built lazily on the first normal chat request.
    buildLlmExecutionConfig();
  }

  async reply(input: PlatformAgentInput): Promise<PlatformAgentReply> {
    return this.replyInternal(input);
  }

  async clearClarificationState(externalUserId: string): Promise<void> {
    await this.clarificationStore.clear(this.clarificationKey(externalUserId));
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

  private async handleClarification(
    input: PlatformAgentInput,
    retryOnVersionConflict = true,
  ): Promise<{
    input?: PlatformAgentInput;
    reply?: PlatformAgentReply;
    /** #649 — the message was a clarification-menu choice, rewritten to a
     *  canned prompt; the input classifier must not run on it. */
    choiceConsumed?: boolean;
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
        state.lastDeliveryFailed !== true &&
        (state.lastReplyText || state.phase === 'consumed')
      ) {
        this.recordClarificationOutcome('replayed');
        return {
          reply: this.staticReply(
            state.lastReplyText ?? buildClarificationMessage(),
            input,
            true,
          ),
        };
      }

      if (
        state &&
        this.clarificationMachine.isStaleEvent(state, input.correlationId)
      ) {
        this.recordClarificationOutcome('stale_reply');
        return {
          reply: this.staticReply(
            state.lastReplyText ?? buildClarificationMessage(),
            input,
            true,
          ),
        };
      }

      if (state?.phase === 'consumed') {
        const failedChoice =
          state.lastDeliveryFailed === true &&
          input.correlationId === state.lastEventId
            ? state.lastChoice
            : undefined;
        const cleared = await this.clarificationStore.clear(key, state.version);
        if (cleared === false) {
          if (retryOnVersionConflict) {
            return this.handleClarification(input, false);
          }
          throw new Error('Clarification state version conflict');
        }
        state = null;
        if (failedChoice) {
          this.recordClarificationOutcome('choice');
          return {
            input: {
              ...input,
              userText: this.buildChoicePrompt(failedChoice),
              userTextParts: undefined,
            },
            choiceConsumed: true,
          };
        }
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
          reply: this.staticReply(
            // #959: the same words double as a stop request outside menu
            // context — the acknowledgement covers both honestly.
            this.isRescheduleCancellation(input.userText)
              ? await this.stopReply(
                  input.externalUserId,
                  isStopIntent(input.userText)
                    ? buildStopAcknowledgedMessage()
                    : buildClarificationCancelledMessage(),
                )
              : buildClarificationCancelledMessage(),
            input,
          ),
        };
      }

      const choice = state
        ? this.clarificationMachine.parseChoice(input.userText)
        : null;
      if (state && choice) {
        const consumed = await this.clarificationStore.set(
          key,
          this.clarificationMachine.consume(
            state,
            input.correlationId,
            now,
            choice,
          ),
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
            userTextParts: undefined,
          },
          choiceConsumed: true,
        };
      }

      const offTopic = isObviouslyOffTopic(input.userText);
      const stop = isStopIntent(input.userText);
      const ambiguous =
        isAmbiguousMessage(input.userText) ||
        this.clarificationMachine.isContradictory(input.userText);

      // #959: a stop request is a clear intent — clear any pending menu and
      // answer honestly instead of re-showing the clarification menu.
      if (stop) {
        if (state) {
          const cleared = await this.clarificationStore.clear(
            key,
            state.version,
          );
          if (cleared === false) {
            throw new Error('Clarification state version conflict');
          }
        }
        this.recordClarificationOutcome('stop_acknowledged');
        return {
          reply: this.staticReply(
            await this.stopReply(input.externalUserId),
            input,
          ),
        };
      }

      if (state && !offTopic && !ambiguous) {
        // Retain a tombstone so delayed choices from the superseded menu cannot
        // execute tools after this new question reaches the agent.
        const superseded = await this.clarificationStore.set(
          key,
          this.clarificationMachine.consume(state, input.correlationId, now),
          state.version,
        );
        if (superseded === false) {
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
      this.recordDegraded(input, 'history_unavailable', 'block_response');
      this.logger.error(
        `Clarification state unavailable externalUserId=${maskExternalId(input.externalUserId)} error=${errorMessage(error, input.externalUserId)}`,
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

  private recordDegraded(
    input: PlatformAgentInput,
    failureClass: LlmDegradedFailureClass,
    action: LlmDegradedAction,
  ): void {
    const event: LlmDegradedModeEvent = {
      platform: this.options.platform ?? 'unknown',
      feature: FEATURE,
      failureClass,
      action,
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    };
    try {
      this.options.metrics?.degradedModeInc?.(event);
    } catch {
      // Telemetry must never change the fail-closed history policy.
    }
    const correlation = input.correlationId
      ? maskExternalIdInText(
          sanitizeLogValue(input.correlationId, 120),
          input.externalUserId,
        )
      : 'n/a';
    this.logger.warn(
      `Chat degraded platform=${event.platform} feature=${FEATURE} failure_class=${failureClass} action=${action} correlation=${correlation} externalUserId=${maskExternalId(input.externalUserId)}`,
    );
  }

  private staticReply(
    text: string,
    input: PlatformAgentInput,
    skipDelivery = false,
  ): PlatformAgentReply {
    if (skipDelivery) this.recordClarificationOutcome('skip_delivery');
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
    fallbackMessage = buildStopAcknowledgedMessage(),
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

  private isRescheduleCancellation(userText: string): boolean {
    return (
      isStopIntent(userText) || this.clarificationMachine.isCancel(userText)
    );
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
        maxLlmRetries: this.options.maxLlmRetries,
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
    label: string,
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
    if (!result.ok && result.reason === 'skipped_circuit_open') return;
    const completion = result.completion;
    try {
      this.usageRecorder.recordFromCompletion({
        feature: 'LLM_INPUT_CLASSIFIER',
        externalUserId: input.externalUserId,
        userId: input.userId,
        provider: completion?.provider,
        model: completion?.model ?? 'unknown',
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
    const systemPromptParts: LlmAgentPromptParts =
      typeof suffix === 'string'
        ? {
            core: CHAT_SYSTEM_PROMPT_CORE,
            overlay,
            identityDisplayName: redactPromptPart(suffix),
          }
        : {
            core: CHAT_SYSTEM_PROMPT_CORE,
            overlay,
            identityDisplayName: redactPromptPart(suffix?.identityDisplayName),
            learnerProfile: redactPromptPart(suffix?.learnerProfile),
          };
    return {
      systemPrompt: composeChatSystemPrompt(systemPromptParts),
      systemPromptParts,
    };
  }
}

function redactPromptPart(
  value: string | null | undefined,
): string | undefined {
  return value ? redactSecrets(value).text : undefined;
}
