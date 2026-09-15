import type { LlmProviderAdapter } from './provider/llm-provider.adapter';
import {
  AGENT_TOOLS,
  isAgentToolName,
  parseAndValidateToolArguments,
  type AgentToolName,
} from './agent.tools';
import {
  detectPromptInjection,
  detectDisclosureProbe,
} from './utils/prompt-injection.utils';
import {
  isObviouslyOffTopic,
  isAmbiguousMessage,
  isStopIntent,
} from './utils/scope.utils';
import { sleep, isAbortError } from './utils/retry.utils';
import { jitteredDelayMs } from '@wispace/bot-common/utils';
import { LlmAllProvidersExhaustedError } from './provider/failover/failover.errors';
import { LlmOverloadError } from './execution/bounded-admission';
import { LlmProviderCircuitOpenError } from './execution/circuit-error';
import {
  buildExhaustionPartialAnswer,
  buildNonDisclosureReply,
  buildPromptInjectionBlockedMessage,
  buildToolCallCapMessage,
  buildWispaceScopeRedirectMessage,
  buildClarificationMessage,
  buildStopAcknowledgedMessage,
} from './messages';
import {
  errorMessage,
  maskExternalId,
  maskExternalIdInText,
  sanitizeLogValue,
} from '@wispace/bot-common/masking';
import {
  AgentMetricsPort,
  LlmExecutionPort,
  LlmSafetyEventPort,
  LlmUsageRecorderPort,
  type LlmDegradedAction,
  type LlmDegradedFailureClass,
  type LlmInjectionSource,
  NOOP_METRICS_PORT,
  ToolExecutorPort,
} from './ports';
import type { LlmAgentConfig, LlmAgentInput, LlmAgentReply } from './types';
import { AgentLimits } from './internal/agent-limits';
import { ContextManager } from './internal/context-manager';
import { SafetyPipeline } from './internal/safety-pipeline';
import { ToolRoundExecutor } from './internal/tool-round-executor';

export { DEFAULT_TOOL_EXECUTION_TIMEOUT_MS } from './internal/agent-limits';

const FEATURE = 'FREE_FORM_CHAT';

function classifyAgentFailure(error: unknown): LlmDegradedFailureClass {
  if (error instanceof LlmAllProvidersExhaustedError) {
    return 'provider_exhausted';
  }
  if (error instanceof LlmProviderCircuitOpenError) {
    return 'provider_circuit_open';
  }
  if (error instanceof LlmOverloadError) {
    return 'execution_overload';
  }
  if (error instanceof LlmRetryExhaustedError) {
    // #549 — the agent-level retry wrapper hides the terminal cause; meter
    // the cause so retry-exhaustion keeps its retry-story meaning instead of
    // collapsing into 'unknown'.
    return error.cause instanceof Error
      ? classifyAgentFailure(error.cause)
      : 'unknown';
  }
  if (isAbortError(error)) {
    return 'timeout';
  }
  return 'unknown';
}

export interface LlmAgentPorts<TToolContext> {
  /** Platform label used for bounded degraded-mode telemetry. */
  platform?: string;
  llmExecution: LlmExecutionPort;
  usageRecorder: LlmUsageRecorderPort;
  safetyEvents: LlmSafetyEventPort;
  toolExecutor: ToolExecutorPort<TToolContext>;
  adapter: LlmProviderAdapter;
  metrics?: AgentMetricsPort;
  logger?: {
    warn: (message: string) => void;
    debug: (message: string) => void;
  };
}

const NOOP_LOGGER = { warn: () => undefined, debug: () => undefined };

const MAX_RETRY_DELAY_MS = 10_000;

export class LlmRetryExhaustedError extends Error {
  constructor(
    public readonly attempts: number,
    cause: unknown,
  ) {
    super(`LLM call failed after ${attempts} attempts`);
    this.cause = cause;
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
function linkAbortSignal(
  source: AbortSignal | undefined,
  target: AbortController,
): void {
  if (!source) {
    return;
  }
  if (source.aborted) {
    target.abort(source.reason);
    return;
  }
  source.addEventListener('abort', () => target.abort(source.reason), {
    once: true,
  });
}

/**
 * Framework-agnostic LLM function-calling orchestration loop, shared across
 * all WISPACE bot platforms. Tool business logic (Wispace API calls, DB reads...)
 * is NOT part of this class — it lives behind `ToolExecutorPort`, implemented per app.
 *
 * The LLM provider is injected via `LlmProviderAdapter` — no direct SDK dependency.
 */
export class LlmAgentService<TToolContext> {
  private readonly limits: AgentLimits;
  private readonly contextManager: ContextManager;
  private readonly safetyPipeline = new SafetyPipeline();
  private readonly toolRoundExecutor: ToolRoundExecutor<TToolContext>;

  constructor(
    config: LlmAgentConfig,
    private readonly ports: LlmAgentPorts<TToolContext>,
  ) {
    this.limits = new AgentLimits(config);
    const metrics = ports.metrics ?? NOOP_METRICS_PORT;
    const logger = ports.logger ?? NOOP_LOGGER;
    this.contextManager = new ContextManager(this.limits);
    this.toolRoundExecutor = new ToolRoundExecutor(
      this.limits,
      ports.toolExecutor,
      metrics,
      logger,
    );
  }

  async reply(
    input: LlmAgentInput,
    toolContext: TToolContext,
  ): Promise<LlmAgentReply> {
    const controller = new AbortController();
    linkAbortSignal(input.signal, controller);
    return withTimeout(
      this.ports.metrics?.timeAgentLoop
        ? this.ports.metrics.timeAgentLoop(FEATURE, () =>
            this.runRounds(input, toolContext, controller.signal),
          )
        : this.runRounds(input, toolContext, controller.signal),
      this.limits.globalAgentTimeoutMs,
      'Agent loop',
      () => controller.abort(),
    );
  }

  /** Single agent loop: LLM call → tool round or final text → exhaustion. */
  private async runRounds(
    input: LlmAgentInput,
    toolContext: TToolContext,
    signal?: AbortSignal,
  ): Promise<LlmAgentReply> {
    const logger = this.ports.logger ?? NOOP_LOGGER;
    const metrics = this.ports.metrics ?? NOOP_METRICS_PORT;
    const adapter = this.ports.adapter;

    const earlyReturn = this.checkEarlyReturns(input);
    if (earlyReturn) {
      if (!adapter.isConfigured()) {
        this.recordDegraded(
          input,
          metrics,
          logger,
          'provider_unconfigured',
          'chat_fallback',
        );
      }
      return earlyReturn.reply;
    }

    const model = adapter.getDefaultModel();
    const context = this.contextManager.build(input, {
      onHistoryInjection: (reason, text) => {
        logger.warn(
          `History entry redacted externalUserId=${maskExternalId(input.externalUserId)} reason=${reason}`,
        );
        this.recordInjection(input, 'history', reason, text);
      },
      onHistoryTrimmed: (droppedTokens) =>
        logger.debug(
          `History truncated ${droppedTokens} tokens to stay within budget externalUserId=${maskExternalId(input.externalUserId)}`,
        ),
    });
    if (!context.fits) {
      this.recordDegraded(
        input,
        metrics,
        logger,
        'invalid_output',
        'chat_fallback',
      );
      return { text: this.buildFallbackReply(input.userText) };
    }
    const messages = context.messages;

    const toolsCalledThisTurn = new Set<AgentToolName>();
    const groundedToolsThisTurn = new Set<AgentToolName>();
    const toolRunsPerName = new Map<AgentToolName, number>();
    let toolExecutionsThisTurn = 0;
    const maxToolRounds = this.limits.maxToolRounds;
    const maxToolExecutionsPerTurn = this.limits.maxToolExecutionsPerTurn;
    const maxToolRunsPerName = this.limits.maxToolRunsPerNamePerTurn;
    let previousToolCallSignature: string | null = null;
    // Loop-generated assistant/tool messages start here — trimming below only
    // drops these, never the system prompt, history or user turn.
    const loopMessagesStart = messages.length;
    let previousRoundFailed = false;

    for (let round = 0; round < maxToolRounds; round++) {
      let response:
        | Awaited<ReturnType<LlmProviderAdapter['chatWithTools']>>
        | undefined;
      try {
        response = await metrics.timeLlmCall(FEATURE, model, round, () =>
          this.ports.llmExecution.run(
            (execSignal) =>
              this.withRetry(
                () =>
                  adapter.chatWithTools({
                    feature: FEATURE,
                    model,
                    messages,
                    tools: AGENT_TOOLS,
                    toolChoice: 'auto',
                    correlationId: input.correlationId,
                    maxOutputTokens: this.limits.maxOutputTokens,
                    signal: execSignal,
                  }),
                round,
                logger,
                execSignal,
              ),
            {
              feature: FEATURE,
              correlationId: input.correlationId,
              signal,
            },
          ),
        );

        this.ports.usageRecorder.recordFromCompletion({
          feature: FEATURE,
          externalUserId: input.externalUserId,
          userId: input.userId,
          provider: response.metadata.provider,
          model: response.metadata.model,
          response: {
            id: response.metadata.responseId ?? '',
            // Chat path forwards the full LlmUsage (cached tokens included),
            // as before typing — report/reminder callers stay field-preserving.
            usage: response.metadata.usage ?? null,
          },
          correlationId: input.correlationId,
          toolRound: round,
        });

        const toolCalls = response.message.toolCalls;

        if (!toolCalls?.length) {
          metrics.llmRoundOutcomeInc(FEATURE, 'direct_reply');

          const text = response.content;
          if (!text) {
            throw new Error('LLM provider returned empty content');
          }

          const safety = this.safetyPipeline.evaluate({
            text,
            userText: input.userText,
            toolsCalled: toolsCalledThisTurn,
            groundedTools: groundedToolsThisTurn,
          });
          if (safety.outcome === 'grounding_blocked') {
            this.recordDegraded(
              input,
              metrics,
              logger,
              'grounding_blocked',
              'block_response',
            );
            logger.warn(
              `LLM_GROUNDING_WARNING feature=${FEATURE} externalUserId=${maskExternalId(
                input.externalUserId,
              )} reason=${safety.reason} tools_called=${[...toolsCalledThisTurn].join(',') || 'none'}`,
            );
            this.ports.safetyEvents.recordGroundingWarning({
              externalUserId: input.externalUserId,
              userId: input.userId,
              correlationId: input.correlationId,
              reason: safety.reason ?? 'unknown',
              userTextPreview: input.userText,
              assistantTextPreview: text,
              toolNamesUsed: [...toolsCalledThisTurn],
            });
          } else if (safety.outcome === 'final_blocked') {
            this.recordDegraded(
              input,
              metrics,
              logger,
              'safety_blocked',
              'block_response',
            );
            logger.warn(
              `LLM final output blocked reason=${safety.reason} externalUserId=${maskExternalId(
                input.externalUserId,
              )} tools_called=${[...toolsCalledThisTurn].join(',') || 'none'}`,
            );
          }
          return { text: safety.text, toolSummary: safety.toolSummary };
        }

        // Per-round call cap (#162): count DISTINCT (name, args) executions
        // after dedupe — a model response fanning out beyond the cap is
        // blocked fail-closed before anything executes.
        const uniqueCallCount = this.countUniqueToolCalls(toolCalls);
        if (uniqueCallCount > this.limits.maxToolCallsPerRound) {
          metrics.llmRoundOutcomeInc(FEATURE, 'duplicate_tool_calls');
          this.recordDegraded(
            input,
            metrics,
            logger,
            'tool_failure',
            'block_response',
          );
          logger.warn(
            `LLM agent blocked tool round: ${uniqueCallCount} unique calls exceed cap=${this.limits.maxToolCallsPerRound} externalUserId=${maskExternalId(
              input.externalUserId,
            )}`,
          );
          return { text: buildToolCallCapMessage() };
        }

        const signature = this.buildToolCallSignature(toolCalls);
        if (signature === previousToolCallSignature && !previousRoundFailed) {
          // Same calls twice AND the previous round succeeded — the LLM is
          // stuck in a loop. A failed round re-calling the same tool is a
          // legitimate retry and must not be cut off.
          metrics.llmRoundOutcomeInc(FEATURE, 'duplicate_tool_calls');
          this.recordDegraded(
            input,
            metrics,
            logger,
            'tool_failure',
            'block_response',
          );
          logger.warn(
            `LLM agent detected duplicate tool calls, stopping early round=${round} externalUserId=${maskExternalId(
              input.externalUserId,
            )} tools_called=${[...toolsCalledThisTurn].join(',') || 'none'}`,
          );
          break;
        }
        previousToolCallSignature = signature;

        // #962 — varied-argument loop detection: the same tool asked for in
        // round after round with a tweaked argument is the same stuck loop,
        // but identical-signature detection cannot see it. Only runs from
        // EARLIER rounds count — a single round legitimately fanning out
        // several distinct lookups of one tool (compare past/current/next
        // week) is a multi-intent turn, not a loop.
        const loopingTool = [...toolRunsPerName.entries()].find(
          ([, runs]) => runs >= maxToolRunsPerName,
        );
        if (loopingTool) {
          metrics.llmRoundOutcomeInc(FEATURE, 'duplicate_tool_calls');
          this.recordDegraded(
            input,
            metrics,
            logger,
            'tool_failure',
            'block_response',
          );
          logger.warn(
            `LLM agent detected varied-argument tool loop tool=${loopingTool[0]} runs=${loopingTool[1]} round=${round} externalUserId=${maskExternalId(
              input.externalUserId,
            )}`,
          );
          break;
        }

        // #962 — per-turn execution budget, accumulated across rounds. The
        // round executes at most the remaining allowance; anything beyond it
        // is refused before execution (a tool error is fed back so the model
        // can still answer from grounded data).
        const remainingExecutions =
          maxToolExecutionsPerTurn - toolExecutionsThisTurn;
        if (remainingExecutions <= 0) {
          metrics.llmRoundOutcomeInc(FEATURE, 'duplicate_tool_calls');
          this.recordDegraded(
            input,
            metrics,
            logger,
            'tool_round_exhausted',
            'partial_answer',
          );
          logger.warn(
            `LLM agent hit per-turn tool budget executions=${toolExecutionsThisTurn} cap=${maxToolExecutionsPerTurn} round=${round} externalUserId=${maskExternalId(
              input.externalUserId,
            )}`,
          );
          break;
        }
        if (uniqueCallCount > remainingExecutions) {
          logger.warn(
            `LLM agent trimming tool round to remaining per-turn budget: unique=${uniqueCallCount} remaining=${remainingExecutions} externalUserId=${maskExternalId(
              input.externalUserId,
            )}`,
          );
        }

        metrics.llmRoundOutcomeInc(FEATURE, 'tool_call');
        messages.push(response.message);

        // Track known tools before execution for summaries and grounding logs.
        for (const toolCall of toolCalls) {
          if (isAgentToolName(toolCall.name)) {
            toolsCalledThisTurn.add(toolCall.name);
          }
        }

        const observationBudget =
          this.contextManager.observationBudget(messages);
        const toolExecution = await this.toolRoundExecutor.execute(
          toolCalls,
          input,
          toolContext,
          observationBudget,
          signal,
          {
            maxExecutions: remainingExecutions,
          },
          {
            onInjection: (reason, rawPreview, toolName) => {
              logger.warn(
                `Tool result injection neutralized externalUserId=${maskExternalId(input.externalUserId)} tool=${toolName} reason=${reason}`,
              );
              this.recordInjection(
                input,
                'tool_result',
                reason,
                rawPreview,
                toolName,
              );
            },
          },
        );
        toolExecutionsThisTurn += toolExecution.executedCount;
        const toolResults = toolExecution.results;

        previousRoundFailed = toolResults.some((result) => !result.succeeded);

        // Track executed runs per tool name for the varied-argument loop
        // check on the next round (#962).
        for (const toolName of toolExecution.successfulToolNames) {
          groundedToolsThisTurn.add(toolName);
          toolRunsPerName.set(
            toolName,
            (toolRunsPerName.get(toolName) ?? 0) + 1,
          );
        }

        for (const result of toolResults) {
          messages.push({
            role: 'tool',
            toolCallId: result.toolCallId,
            content: result.content,
          });
        }

        // Cumulative tool-result budget: individual results are sanitized per
        // string, but across rounds they can exceed the model context. Drop
        // the oldest loop-generated messages until the total fits.
        const trim = this.contextManager.trimLoopMessages(
          messages,
          loopMessagesStart,
        );
        for (const toolName of new Set(trim.droppedToolNames)) {
          metrics.observationOutcomeInc?.(
            isAgentToolName(toolName) ? toolName : 'unknown',
            'dropped',
          );
        }
        if (!trim.fits) {
          this.recordDegraded(
            input,
            metrics,
            logger,
            'invalid_output',
            'chat_fallback',
          );
          return { text: this.buildFallbackReply(input.userText) };
        }
      } catch (err) {
        // #549 — emit a zero-token error row only when the LLM call itself
        // failed (`response` never assigned). Tool/grounding failures below
        // keep the successful round's usage row untouched: no LLM spend is
        // hidden, and no tool failure pollutes the spend data.
        if (response === undefined) {
          this.recordLlmFailureRow(
            input,
            model,
            round,
            input.correlationId,
            err,
          );
        }
        this.recordDegraded(
          input,
          metrics,
          logger,
          classifyAgentFailure(err),
          'chat_fallback',
        );
        throw err;
      }
    }

    // Exhausted all rounds without a final text reply — give a partial
    // answer listing the grounded data actually retrieved (#207 item 4).
    metrics.llmRoundOutcomeInc(FEATURE, 'exhausted');
    this.recordDegraded(
      input,
      metrics,
      logger,
      'tool_round_exhausted',
      'partial_answer',
    );
    logger.warn(
      `LLM agent exhausted maxToolRounds=${this.limits.maxToolRounds} externalUserId=${maskExternalId(
        input.externalUserId,
      )} tools_called=${[...toolsCalledThisTurn].join(',') || 'none'}`,
    );
    const toolSummary =
      toolsCalledThisTurn.size > 0
        ? `[Đã tra cứu: ${[...toolsCalledThisTurn].join('; ')}]`
        : undefined;
    return {
      text: buildExhaustionPartialAnswer([...groundedToolsThisTurn]),
      exhausted: true,
      toolSummary,
    };
  }

  private buildFallbackReply(userText: string): string {
    const trimmed = userText.trim();
    if (!trimmed || isObviouslyOffTopic(trimmed)) {
      return buildWispaceScopeRedirectMessage();
    }

    return [
      'WISPACE đang bảo trì trợ lý AI tạm thời.',
      '',
      'Bạn có thể hỏi tự do về tiến độ, lịch học — WISPACE cũng gửi báo cáo và nhắc lịch tự động.',
    ].join('\n');
  }

  private async withRetry<T>(
    fn: () => Promise<T>,
    round: number,
    logger: { warn: (msg: string) => void },
    signal?: AbortSignal,
  ): Promise<T> {
    const maxRetries = this.limits.maxLlmRetries;
    if (maxRetries === 0) {
      // Retries disabled — single attempt, throw the raw error so the outer
      // llmExecution layer (retryWithBackoff) can classify it itself.
      return fn();
    }
    const baseDelay = this.limits.retryBaseDelayMs;
    let lastErr: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (signal?.aborted) {
        throw signal.reason ?? lastErr ?? new Error('Aborted');
      }
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (
          signal?.aborted ||
          isAbortError(err) ||
          !this.ports.adapter.isRetryableError(err) ||
          attempt === maxRetries
        ) {
          break;
        }
        // Shared equal-jitter policy (packages/bot-common) applied after the
        // cap — spreads concurrent chat retries that aligned on the same
        // provider 429/5xx so they do not stampede.
        const delay = jitteredDelayMs(
          Math.min(baseDelay * Math.pow(2, attempt), MAX_RETRY_DELAY_MS),
        );
        logger.warn(
          `LLM_RETRY attempt=${attempt + 1}/${maxRetries} round=${round} delay=${Math.round(delay)}ms`,
        );
        await sleep(delay, signal);
      }
    }

    if (signal?.aborted || isAbortError(lastErr)) {
      throw lastErr ?? signal?.reason ?? new Error('Aborted');
    }
    throw new LlmRetryExhaustedError(maxRetries + 1, lastErr);
  }

  private recordDegraded(
    input: LlmAgentInput,
    metrics: AgentMetricsPort,
    logger: { warn: (message: string) => void },
    failureClass: LlmDegradedFailureClass,
    action: LlmDegradedAction,
  ): void {
    const correlationId = input.correlationId
      ? maskExternalIdInText(
          sanitizeLogValue(input.correlationId, 120),
          input.externalUserId,
        )
      : 'n/a';
    const event = {
      platform: this.ports.platform ?? 'unknown',
      feature: FEATURE,
      failureClass,
      action,
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    };
    try {
      metrics.degradedModeInc?.(event);
    } catch {
      // Telemetry must never change the user-visible fallback behavior.
    }
    logger.warn(
      `LLM degraded platform=${event.platform} feature=${FEATURE} failure_class=${failureClass} action=${action} correlation=${correlationId} externalUserId=${maskExternalId(input.externalUserId)}`,
    );
  }

  /**
   * #629 — record a neutralized prompt-injection payload (fresh input, a tool
   * result, or a replayed history entry). Best-effort telemetry: the redacted
   * excerpt + hash are persisted by the safety-event port, never the raw text
   * (#122), and this must never break the reply path.
   */
  private recordInjection(
    input: LlmAgentInput,
    source: LlmInjectionSource,
    reason: string,
    textPreview: string,
    toolName?: string,
  ): void {
    try {
      this.ports.safetyEvents.recordInjectionEvent({
        externalUserId: input.externalUserId,
        userId: input.userId,
        correlationId: input.correlationId,
        source,
        reason,
        textPreview: textPreview.slice(0, 200),
        toolName,
      });
    } catch {
      // best-effort — telemetry failure never blocks the reply
    }
    (this.ports.metrics ?? NOOP_METRICS_PORT).injectionBlockedInc?.(source);
  }

  /**
   * #549 — one zero-token failure row for an LLM call that never produced a
   * completion, classified with the bounded failure class (never raw text).
   * Best-effort: metering must not mask the original failure, especially
   * under incident conditions when the telemetry path itself may be down.
   */
  private recordLlmFailureRow(
    input: LlmAgentInput,
    model: string,
    toolRound: number,
    correlationId: string | undefined,
    error: unknown,
  ): void {
    try {
      this.ports.usageRecorder.recordFromCompletion({
        feature: FEATURE,
        externalUserId: input.externalUserId,
        userId: input.userId,
        model,
        response: { id: '', usage: null },
        correlationId,
        toolRound,
        status: 'error',
        errorMessage: classifyAgentFailure(error),
      });
    } catch (recorderError) {
      const logger = this.ports.logger ?? NOOP_LOGGER;
      logger.warn(
        `LLM failure usage record failed externalUserId=${maskExternalId(
          input.externalUserId,
        )} error=${errorMessage(recorderError)}`,
      );
    }
  }

  /** Detects the model repeating an identical tool call across rounds (stuck loop). */
  private buildToolCallSignature(
    toolCalls: Array<{ name: string; arguments: string }>,
  ): string {
    return toolCalls
      .map((tc) => this.toolCallKey(tc))
      .sort()
      .join('|');
  }

  // ─── Agent-loop helpers ────────────────────────────────────────────────

  private checkEarlyReturns(input: LlmAgentInput): {
    blocked: true;
    reply: LlmAgentReply;
  } | null {
    const logger = this.ports.logger ?? NOOP_LOGGER;
    const adapter = this.ports.adapter;

    if (!adapter.isConfigured()) {
      return {
        blocked: true,
        reply: { text: this.buildFallbackReply(input.userText) },
      };
    }

    const injectionCheck = detectPromptInjection(input.userText);
    if (injectionCheck.isInjection) {
      logger.warn(
        `Prompt injection blocked externalUserId=${maskExternalId(
          input.externalUserId,
        )} reason=${injectionCheck.reason}`,
      );
      this.recordInjection(
        input,
        'user_input',
        injectionCheck.reason ?? 'unknown',
        input.userText,
      );
      // System-prompt/instruction extraction routes to the standard
      // non-disclosure reply, not a distinct "blocked" message — a
      // differential response is itself an oracle (#625).
      return {
        blocked: true,
        reply: {
          text:
            injectionCheck.reason === 'extraction'
              ? buildNonDisclosureReply()
              : buildPromptInjectionBlockedMessage(),
        },
      };
    }

    // Non-disclosure probe (#625): polite/direct questions for model,
    // provider, prompt, architecture, params, infra, guardrails or tool
    // capabilities. Defense-in-depth — the bot gateways run the same check
    // before the LLM pipeline.
    const disclosureProbe = detectDisclosureProbe(input.userText);
    if (disclosureProbe.probed) {
      logger.warn(
        `Disclosure probe deflected externalUserId=${maskExternalId(
          input.externalUserId,
        )} category=${disclosureProbe.category}`,
      );
      return {
        blocked: true,
        reply: { text: buildNonDisclosureReply() },
      };
    }

    if (isObviouslyOffTopic(input.userText)) {
      return {
        blocked: true,
        reply: { text: buildWispaceScopeRedirectMessage() },
      };
    }

    // #959: a stop request is a clear intent — answer it honestly instead of
    // the clarification menu.
    if (isStopIntent(input.userText)) {
      return {
        blocked: true,
        reply: { text: buildStopAcknowledgedMessage() },
      };
    }

    if (isAmbiguousMessage(input.userText)) {
      return {
        blocked: true,
        reply: { text: buildClarificationMessage() },
      };
    }

    return null;
  }

  private toolCallKey(call: { name: string; arguments: string }): string {
    const validated = parseAndValidateToolArguments(
      call.name,
      call.arguments || '{}',
    );
    return `${call.name}:${validated.ok ? validated.canonicalArgs : call.arguments || '{}'}`;
  }

  private countUniqueToolCalls(
    toolCalls: Array<{ name: string; arguments: string }>,
  ): number {
    return new Set(toolCalls.map((call) => this.toolCallKey(call))).size;
  }
}
