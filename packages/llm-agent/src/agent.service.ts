import type { LlmProviderAdapter } from './provider/llm-provider.adapter';
import type { LlmMessage, LlmProviderMetadata } from './provider/types';
import {
  AGENT_TOOLS,
  getAgentToolDefinition,
  isAgentToolName,
  parseAndValidateToolArguments,
} from './agent.tools';
import { checkLlmGrounding } from './utils/llm-grounding.utils';
import {
  detectPromptInjection,
  detectDisclosureProbe,
  isInjectionSanitizeReason,
  sanitizeUntrustedTextForLlm,
} from './utils/prompt-injection.utils';
import {
  fitToolObservation,
  observationMarker,
  reduceToolObservation,
} from './utils/tool-observation';
import { isObviouslyOffTopic, isAmbiguousMessage } from './utils/scope.utils';
import { sanitizeReplyText } from './utils/text.utils';
import { checkFinalOutputSafety } from './utils/final-output.utils';
import { sleep, isAbortError } from './utils/retry.utils';
import { jitteredDelayMs } from '@wispace/bot-common/utils';
import { LlmAllProvidersExhaustedError } from './provider/failover/failover.errors';
import { LlmOverloadError } from './execution/bounded-admission';
import { LlmProviderCircuitOpenError } from './execution/circuit-error';
import {
  buildExhaustionPartialAnswer,
  buildFinalOutputBlockedMessage,
  buildNonDisclosureReply,
  buildPromptInjectionBlockedMessage,
  buildToolCallCapMessage,
  buildWispaceScopeRedirectMessage,
  buildGroundingBlockedMessage,
  buildClarificationMessage,
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
import type { ToolObservationOutcome } from './utils/tool-observation';
import {
  computeCompactionCoverage,
  type CompactionCachePort,
  type CompactionCoverage,
} from '@wispace/chat-history';
import type {
  ChatHistoryMessage,
  LlmAgentConfig,
  LlmAgentInput,
  LlmAgentReply,
  LlmAgentStreamEvent,
} from './types';

const DEFAULT_MAX_TOOL_ROUNDS = 6;
const DEFAULT_MAX_TOOL_CALLS_PER_ROUND = 4;
const DEFAULT_MAX_CONTEXT_CHARS = 24_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 1024;
const DEFAULT_TOOL_EXECUTION_TIMEOUT_MS = 10_000;
const DEFAULT_GLOBAL_AGENT_TIMEOUT_MS = 60_000;
const DEFAULT_COMPACTION_SUMMARY_MAX_TOKENS = 500;
const DEFAULT_COMPACTION_RECENT_TURNS = 2;
const COMPACTION_MIN_DROPPED_TOKENS = 100;
// Generous per-entry cap for history re-sanitization (#629) — normal turns
// pass through untouched; the token-budget loop below handles real trimming.
const MAX_HISTORY_ENTRY_CHARS = 8_000;
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
  if (isAbortError(error)) {
    return 'timeout';
  }
  return 'unknown';
}

/**
 * Simple token estimator — Vietnamese text averages ~1.8 tokens/char due to
 * diacritics and word segmentation. English averages ~0.75 tokens/char.
 * We use a conservative 1.5 multiplier to stay within context windows.
 */
function estimateTokens(text: string): number {
  // Count non-ASCII characters (Vietnamese diacritics, CJK, etc.)
  // eslint-disable-next-line no-control-regex
  const nonAscii = (text.match(/[^\x00-\x7F]/g) ?? []).length;
  const ascii = text.length - nonAscii;
  return Math.ceil(nonAscii * 1.5 + ascii * 0.75);
}

// Injected after the platform system prompt to guide the model's reasoning.
const REASONING_INSTRUCTION = `
---
Trước khi trả lời, hãy:
1. Xác định ý định của học viên (tiến độ học, lịch học, đổi lịch, hay câu hỏi chung).
2. Nếu cần dữ liệu từ nhiều tool, hãy gọi tất cả trong cùng một lượt để tiết kiệm thời gian.
3. Chỉ trả lời bằng văn bản sau khi đã có đủ dữ liệu cần thiết.
`.trim();

export interface LlmAgentPorts<TToolContext> {
  /** Platform label used for bounded degraded-mode telemetry. */
  platform?: string;
  llmExecution: LlmExecutionPort;
  usageRecorder: LlmUsageRecorderPort;
  safetyEvents: LlmSafetyEventPort;
  toolExecutor: ToolExecutorPort<TToolContext>;
  adapter: LlmProviderAdapter;
  /**
   * Persisted compaction-summary cache (#704). Optional — absent means every
   * over-budget turn re-summarizes (legacy). Cache implementations are
   * already platform-scoped; `platform` below only gates cache use, it never
   * keys anything (each platform owns its agent + cache instances).
   */
  compactionCache?: CompactionCachePort;
  metrics?: AgentMetricsPort;
  logger?: {
    warn: (message: string) => void;
    debug: (message: string) => void;
  };
}

const NOOP_LOGGER = { warn: () => undefined, debug: () => undefined };

const DEFAULT_MAX_LLM_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 100;
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
 * #703 — lets one waiter stop waiting for shared work without cancelling it
 * for the other waiters. The shared promise is untouched; only this waiter's
 * wait rejects when its own signal fires.
 */
function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new Error('Aborted'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(signal.reason ?? new Error('Aborted'));
    };
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * #703 — one compaction generation: the replayable summary message plus the
 * provider completion metadata needed for usage metering.
 */
interface CompactionGeneration {
  messages: ChatHistoryMessage[];
  completion: LlmProviderMetadata;
}

/**
 * Framework-agnostic LLM function-calling orchestration loop, shared across
 * all WISPACE bot platforms. Tool business logic (Wispace API calls, DB reads...)
 * is NOT part of this class — it lives behind `ToolExecutorPort`, implemented per app.
 *
 * The LLM provider is injected via `LlmProviderAdapter` — no direct SDK dependency.
 */
export class LlmAgentService<TToolContext> {
  /**
   * #704 — in-flight compaction generations keyed by
   * `${externalUserId}:${count}:${hash}`. Concurrent over-budget turns for the
   * same dropped prefix share one LLM call instead of stampeding duplicates.
   * Entries are removed once settled, so the map never grows.
   *
   * #703 — the controller belongs to the entry, not to any single waiter: a
   * waiter's own abort only stops its wait (via `raceWithAbort`); the shared
   * request is aborted only when the last waiter leaves.
   */
  private readonly compactionInflight = new Map<
    string,
    {
      promise: Promise<CompactionGeneration | null>;
      controller: AbortController;
      waiters: number;
    }
  >();

  constructor(
    private readonly config: LlmAgentConfig,
    private readonly ports: LlmAgentPorts<TToolContext>,
  ) {}

  async reply(
    input: LlmAgentInput,
    toolContext: TToolContext,
  ): Promise<LlmAgentReply> {
    const controller = new AbortController();
    linkAbortSignal(input.signal, controller);
    return withTimeout(
      this.ports.metrics?.timeAgentLoop
        ? this.ports.metrics.timeAgentLoop(FEATURE, () =>
            this.collectReply(input, toolContext, controller.signal),
          )
        : this.collectReply(input, toolContext, controller.signal),
      this.getGlobalAgentTimeoutMs(),
      'Agent loop',
      () => controller.abort(),
    );
  }

  /** Runs the agent loop and returns the final reply (throws on error). */
  private async collectReply(
    input: LlmAgentInput,
    toolContext: TToolContext,
    signal?: AbortSignal,
  ): Promise<LlmAgentReply> {
    let reply: LlmAgentReply | undefined;
    for await (const event of this.runRounds(input, toolContext, signal)) {
      if (event.type === 'error') {
        throw event.error;
      }
      if (event.type === 'tool_start') {
        continue;
      }
      reply = event.reply;
    }
    if (!reply) {
      throw new Error('LLM agent loop ended without a reply');
    }
    return reply;
  }

  /**
   * Streaming variant of `reply()`. Tool-calling rounds run as normal (non-streaming)
   * because the full response is needed to dispatch tool calls. The **final text** is
   * emitted as a single `delta` event once available (the provider call itself is
   * non-streaming — see `runRounds`), enabling callers to show progressive output or
   * send early message bubbles.
   *
   * Always ends with a single `done` event (or `error` on unrecoverable failure).
   */
  async *replyStream(
    input: LlmAgentInput,
    toolContext: TToolContext,
  ): AsyncIterable<LlmAgentStreamEvent> {
    const controller = new AbortController();
    linkAbortSignal(input.signal, controller);
    const iterator = this.runRounds(input, toolContext, controller.signal)[
      Symbol.asyncIterator
    ]();
    const deadline = Date.now() + this.getGlobalAgentTimeoutMs();

    try {
      while (true) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          controller.abort();
          throw new Error(
            `Agent loop timed out after ${this.getGlobalAgentTimeoutMs()}ms`,
          );
        }

        const next = await withTimeout(
          iterator.next(),
          remainingMs,
          'Agent loop',
          () => controller.abort(),
        );
        if (next.done) {
          break;
        }

        const event = next.value;
        if (event.type === 'error') {
          yield { type: 'error', error: event.error };
          return;
        }
        if (event.type === 'tool_start') {
          yield { type: 'tool_start', toolName: event.toolName };
          continue;
        }
        if (event.type === 'final_text') {
          yield { type: 'delta', textDelta: event.text };
        }
        yield { type: 'done', reply: event.reply };
        return;
      }
    } catch (error) {
      yield { type: 'error', error };
      return;
    }
    yield {
      type: 'error',
      error: new Error('LLM agent loop ended without a reply'),
    };
  }

  /**
   * Single agent loop shared by `reply()` and `replyStream()`:
   * LLM call → usage record → tool-call round or final text → exhausted.
   * Emits `final_text` (with the text to stream) for LLM-generated replies,
   * plain `done` for early returns / exhausted fallbacks.
   */
  private async *runRounds(
    input: LlmAgentInput,
    toolContext: TToolContext,
    signal?: AbortSignal,
  ): AsyncGenerator<
    | { type: 'tool_start'; toolName: string }
    | { type: 'final_text'; text: string; reply: LlmAgentReply }
    | { type: 'done'; reply: LlmAgentReply }
    | { type: 'error'; error: unknown }
  > {
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
      yield { type: 'done', reply: earlyReturn.reply };
      return;
    }

    const model = adapter.getDefaultModel();
    const messages = await this.buildMessages(input, signal);

    const toolsCalledThisTurn = new Set<string>();
    const groundedToolsThisTurn = new Set<string>();
    const maxToolRounds = this.getMaxToolRounds();
    let previousToolCallSignature: string | null = null;
    // Loop-generated assistant/tool messages start here — trimming below only
    // drops these, never the system prompt, history or user turn.
    const loopMessagesStart = messages.length;
    let previousRoundFailed = false;

    for (let round = 0; round < maxToolRounds; round++) {
      try {
        const response = await metrics.timeLlmCall(FEATURE, model, round, () =>
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
                    maxOutputTokens: this.getMaxOutputTokens(),
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

          const groundingCheck = checkLlmGrounding(
            text,
            groundedToolsThisTurn,
            input.userText,
          );
          if (groundingCheck.suspicious) {
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
              )} reason=${groundingCheck.reason} tools_called=${[...toolsCalledThisTurn].join(',') || 'none'}`,
            );
            this.ports.safetyEvents.recordGroundingWarning({
              externalUserId: input.externalUserId,
              userId: input.userId,
              correlationId: input.correlationId,
              reason: groundingCheck.reason ?? 'unknown',
              userTextPreview: input.userText,
              assistantTextPreview: text,
              toolNamesUsed: [...toolsCalledThisTurn],
            });
            const blockedText = buildGroundingBlockedMessage();
            const toolSummary =
              toolsCalledThisTurn.size > 0
                ? `[Đã tra cứu: ${[...toolsCalledThisTurn].join('; ')}]`
                : undefined;
            yield {
              type: 'final_text',
              text: blockedText,
              reply: { text: blockedText, toolSummary },
            };
            return;
          }

          const sanitized = sanitizeReplyText(text);
          const toolSummary =
            toolsCalledThisTurn.size > 0
              ? `[Đã tra cứu: ${[...toolsCalledThisTurn].join('; ')}]`
              : undefined;

          // Final-output guardrail (#165): never deliver a reply that leaks
          // system-prompt material or credential-shaped content — fail
          // closed. A system-prompt echo or a vendor/model identifier is
          // redacted to the standard non-disclosure line (#625); a
          // credential leak still falls to the generic blocked message.
          const safety = checkFinalOutputSafety(sanitized);
          if (safety.unsafe) {
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
            const blockedText =
              safety.reason === 'credential_leak'
                ? buildFinalOutputBlockedMessage()
                : buildNonDisclosureReply();
            yield {
              type: 'final_text',
              text: blockedText,
              reply: { text: blockedText, toolSummary },
            };
            return;
          }

          yield {
            type: 'final_text',
            text: sanitized,
            reply: { text: sanitized, toolSummary },
          };
          return;
        }

        // Per-round call cap (#162): count DISTINCT (name, args) executions
        // after dedupe — a model response fanning out beyond the cap is
        // blocked fail-closed before anything executes.
        const uniqueCallCount = this.countUniqueToolCalls(toolCalls);
        if (uniqueCallCount > this.getMaxToolCallsPerRound()) {
          metrics.llmRoundOutcomeInc(FEATURE, 'duplicate_tool_calls');
          this.recordDegraded(
            input,
            metrics,
            logger,
            'tool_failure',
            'block_response',
          );
          logger.warn(
            `LLM agent blocked tool round: ${uniqueCallCount} unique calls exceed cap=${this.getMaxToolCallsPerRound()} externalUserId=${maskExternalId(
              input.externalUserId,
            )}`,
          );
          yield {
            type: 'done',
            reply: { text: buildToolCallCapMessage() },
          };
          return;
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

        metrics.llmRoundOutcomeInc(FEATURE, 'tool_call');
        messages.push(response.message);

        // Emit tool_start for known calls before parallel execution.
        for (const toolCall of toolCalls) {
          if (isAgentToolName(toolCall.name)) {
            toolsCalledThisTurn.add(toolCall.name);
            yield { type: 'tool_start', toolName: toolCall.name };
          }
        }

        const observationBudget = Math.max(
          0,
          this.getMaxContextChars() - this.messageChars(messages),
        );
        const toolResults = await this.executeToolCalls(
          toolCalls,
          input,
          toolContext,
          toolsCalledThisTurn,
          observationBudget,
          signal,
        );

        previousRoundFailed = toolResults.some((result) => !result.succeeded);

        for (const result of toolResults) {
          if (result.succeeded) {
            groundedToolsThisTurn.add(result.toolName);
          }
          messages.push({
            role: 'tool',
            toolCallId: result.toolCallId,
            content: result.content,
          });
        }

        // Cumulative tool-result budget: individual results are sanitized per
        // string, but across rounds they can exceed the model context. Drop
        // the oldest loop-generated messages until the total fits.
        this.trimLoopMessages(messages, loopMessagesStart, metrics);
      } catch (err) {
        this.recordDegraded(
          input,
          metrics,
          logger,
          classifyAgentFailure(err),
          'chat_fallback',
        );
        yield { type: 'error', error: err };
        return;
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
      `LLM agent exhausted maxToolRounds=${this.getMaxToolRounds()} externalUserId=${maskExternalId(
        input.externalUserId,
      )} tools_called=${[...toolsCalledThisTurn].join(',') || 'none'}`,
    );
    const toolSummary =
      toolsCalledThisTurn.size > 0
        ? `[Đã tra cứu: ${[...toolsCalledThisTurn].join('; ')}]`
        : undefined;
    yield {
      type: 'done',
      reply: {
        text: buildExhaustionPartialAnswer([...groundedToolsThisTurn]),
        exhausted: true,
        toolSummary,
      },
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

  /**
   * Drops loop-generated messages until the whole `messages` array fits the
   * context budget.
   *
   * Assistant tool-call frames are dropped oldest-first TOGETHER with the
   * tool results that follow them (a `tool` message without its preceding
   * `assistant` tool-call frame is rejected by providers). Dropping whole
   * groups from the front means the NEWEST tool results — the ones the model
   * has not consumed yet — survive the longest (#207 item 5). Only when no
   * assistant frame is left does the trim fall back to dropping messages
   * outright. Never touches messages before `loopStartIndex` (system prompt,
   * history, user turn).
   */
  private trimLoopMessages(
    messages: LlmMessage[],
    loopStartIndex: number,
    metrics: AgentMetricsPort,
  ): void {
    const budget = this.getMaxContextChars();
    let total = this.messageChars(messages);

    while (total > budget && messages.length > loopStartIndex) {
      const assistantIndex = this.findFirstLoopAssistantIndex(
        messages,
        loopStartIndex,
      );
      const dropIndex = assistantIndex === -1 ? loopStartIndex : assistantIndex;
      const removed = messages.splice(dropIndex, 1)[0];
      total -= this.messageChars(removed);

      if (removed?.toolCalls?.length) {
        // Drop the tool results that followed this frame (they reference its
        // call ids) so the message list stays valid for the next LLM call.
        while (
          messages.length > dropIndex &&
          messages[dropIndex]?.role === 'tool'
        ) {
          const toolMessage = messages[dropIndex];
          if (toolMessage) {
            total -= this.messageChars(toolMessage);
          }
          messages.splice(dropIndex, 1);
        }

        // Keep a trustworthy indication that an older observation was
        // omitted. This assistant message has no tool calls, so it cannot
        // orphan a provider tool-result message.
        const toolNames = removed.toolCalls.map((call) =>
          isAgentToolName(call.name) ? call.name : 'unknown',
        );
        const markerContent = JSON.stringify({
          _observation: 'dropped',
          tools: [...new Set(toolNames)],
          count: removed.toolCalls.length,
        });
        messages.splice(dropIndex, 0, {
          role: 'assistant',
          content: markerContent,
        });
        total += markerContent.length;
        for (const toolName of new Set(toolNames)) {
          metrics.observationOutcomeInc?.(toolName, 'dropped');
        }
      }
    }
  }

  private messageChars(value: LlmMessage[] | LlmMessage | undefined): number {
    if (Array.isArray(value)) {
      return value.reduce(
        (sum, message) => sum + this.messageChars(message),
        0,
      );
    }
    if (!value) return 0;
    return (
      (value.content?.length ?? 0) +
      (value.toolCalls ?? []).reduce(
        (sum, call) => sum + (call.arguments?.length ?? 0),
        0,
      )
    );
  }

  private findFirstLoopAssistantIndex(
    messages: LlmMessage[],
    loopStartIndex: number,
  ): number {
    for (let i = loopStartIndex; i < messages.length; i++) {
      if (messages[i]?.role === 'assistant') {
        return i;
      }
    }
    return -1;
  }

  /**
   * Fix 2 — re-sanitize every replayed history entry with the SAME pipeline as
   * fresh input (#629): control-char stripping, secret redaction and the
   * injection pattern scan all run again on replay — a stored turn is never
   * trusted because it "passed once". An injection hit is metered
   * (`source: 'history'`); benign trims (`secret_redacted`, length) are not.
   * Fix 3 — truncate history to stay within context token budget.
   * #413 — semantic compaction: summarize old entries instead of dropping them.
   */
  private async buildSafeHistory(
    input: LlmAgentInput,
    history: ChatHistoryMessage[],
    systemPrompt: string,
    userText: string,
    externalUserId: string,
    logger: {
      warn: (message: string) => void;
      debug: (message: string) => void;
    },
    signal?: AbortSignal,
  ): Promise<ChatHistoryMessage[]> {
    const redacted = history.map((entry) => {
      const clean = sanitizeUntrustedTextForLlm(entry.content, {
        maxChars: MAX_HISTORY_ENTRY_CHARS,
      });
      if (!clean.wasSanitized) return entry;
      if (isInjectionSanitizeReason(clean.reason)) {
        logger.warn(
          `History entry redacted externalUserId=${maskExternalId(
            externalUserId,
          )} reason=${clean.reason}`,
        );
        this.recordInjection(
          input,
          'history',
          clean.reason ?? 'unknown',
          entry.content,
        );
      }
      return { ...entry, content: clean.text };
    });

    const maxTokens = this.getMaxInputTokens();
    const fixedTokens = estimateTokens(systemPrompt) + estimateTokens(userText);
    let budget = maxTokens - fixedTokens;

    // Collect entries that fit within budget (newest-first)
    const result: ChatHistoryMessage[] = [];
    let droppedTokens = 0;
    for (let i = redacted.length - 1; i >= 0; i--) {
      const entry = redacted[i];
      if (!entry) continue;
      const entryTokens = estimateTokens(entry.content);

      if (budget >= entryTokens) {
        result.unshift(entry);
        budget -= entryTokens;
      } else {
        droppedTokens += entryTokens;
      }
    }

    // #413: Semantic compaction — if enough tokens were dropped, summarize them
    const compactionEnabled = this.getCompactionEnabled();
    const shouldCompact =
      compactionEnabled &&
      droppedTokens >= COMPACTION_MIN_DROPPED_TOKENS &&
      result.length > 0;

    if (shouldCompact) {
      const droppedEntries = redacted.slice(0, redacted.length - result.length);
      const compacted = await this.compactHistoryCached(
        input,
        droppedEntries,
        externalUserId,
        logger,
        signal,
      );
      if (compacted) {
        const recentTurns = this.getCompactionRecentTurns();
        result.splice(
          0,
          result.length - recentTurns * 2,
          ...compacted.messages,
        );
        this.ports.metrics?.compactionOutcomeInc?.(
          compacted.reused ? 'reused' : 'compacted',
        );
        logger.debug(
          `History compacted externalUserId=${maskExternalId(
            externalUserId,
          )} dropped_tokens=${droppedTokens} reused=${compacted.reused} summary_tokens=${estimateTokens(
            compacted.messages[0]?.content ?? '',
          )}`,
        );
      } else {
        this.ports.metrics?.compactionOutcomeInc?.('fallback');
        logger.warn(
          `History compaction failed, falling back to truncation externalUserId=${maskExternalId(
            externalUserId,
          )}`,
        );
      }
    } else if (droppedTokens > 0) {
      this.ports.metrics?.compactionOutcomeInc?.('skipped');
      logger.debug(
        `History truncated ${droppedTokens} tokens to stay within budget externalUserId=${maskExternalId(
          externalUserId,
        )}`,
      );
    }

    return result;
  }

  /**
   * #413 — Summarize old history entries via LLM compaction call.
   * Returns a single summary message entry plus completion metadata, or null
   * on failure (caller falls back to truncation).
   *
   * #703 — the call goes through `llmExecution.run` like every other provider
   * call (limiter, deadline, breaker, shared retry — no agent-level `withRetry`
   * on top, so this never recreates the stacked-retry shape from #514).
   */
  private async compactHistory(
    entries: ChatHistoryMessage[],
    externalUserId: string,
    logger: {
      warn: (message: string) => void;
      debug: (message: string) => void;
    },
    signal?: AbortSignal,
  ): Promise<CompactionGeneration | null> {
    if (entries.length === 0) return null;

    const summaryMaxTokens = this.getCompactionSummaryMaxTokens();
    const historyText = entries
      .map((e) => `${e.role}: ${sanitizeUntrustedTextForLlm(e.content)}`)
      .join('\n');

    const compactionPrompt = `Summarize the following conversation history into a concise summary (max ${summaryMaxTokens} tokens). Include: intent, preferences, decisions, unresolved questions. Exclude: specific scores, dates, numbers, identity details, side-effect authorizations.

Conversation history:
${historyText}

Summary:`;

    try {
      const adapter = this.ports.adapter;
      const model = adapter.getDefaultModel();
      const correlationId = `compaction:${externalUserId}`;
      const result = await this.ports.llmExecution.run(
        (execSignal) =>
          adapter.chatWithTools({
            feature: FEATURE,
            model,
            messages: [{ role: 'user', content: compactionPrompt }],
            tools: [],
            toolChoice: 'none',
            correlationId,
            maxOutputTokens: summaryMaxTokens,
            signal: execSignal,
          }),
        { feature: FEATURE, correlationId, signal },
      );

      const summaryText = result.content;
      if (!summaryText) {
        return null;
      }

      // Output safety check
      const safetyCheck = checkFinalOutputSafety(summaryText);
      if (safetyCheck.unsafe) {
        logger.warn(
          `Compaction summary failed safety check externalUserId=${maskExternalId(
            externalUserId,
          )} reason=${safetyCheck.reason}`,
        );
        return null;
      }

      // AC#3: Strip factual data that should not be in summary (scores, dates, numbers)
      const sanitized = this.sanitizeCompactionSummary(summaryText);
      if (!sanitized) {
        logger.warn(
          `Compaction summary stripped to empty externalUserId=${maskExternalId(
            externalUserId,
          )}`,
        );
        return null;
      }
      return {
        messages: [
          {
            role: 'tool_summary' as const,
            content: `[Compacted summary of ${entries.length} earlier messages] ${sanitized}`,
          },
        ],
        completion: result.metadata,
      };
    } catch (error) {
      const safeError = maskExternalIdInText(
        sanitizeUntrustedTextForLlm(errorMessage(error), {
          maxChars: 500,
          unsafePlaceholder: 'Compaction failed',
        }).text,
        externalUserId,
      );
      logger.warn(
        `Compaction LLM call failed externalUserId=${maskExternalId(
          externalUserId,
        )} error=${safeError}`,
      );
      return null;
    }
  }

  /**
   * #704 — persisted compaction summary. An unchanged dropped prefix reuses
   * the cached summary (no LLM call, `reused: true`); a changed prefix
   * regenerates once and refreshes the cache. No cache wired or no platform
   * → legacy uncached path. Every cache failure is fail-open.
   *
   * #703 — `signal` is the caller's cancellation signal. The shared
   * generation is NOT driven by any single waiter's signal: each waiter only
   * races its own wait, and the entry-owned controller aborts the shared
   * request when the last waiter leaves.
   */
  private async compactHistoryCached(
    input: LlmAgentInput,
    entries: ChatHistoryMessage[],
    externalUserId: string,
    logger: {
      warn: (message: string) => void;
      debug: (message: string) => void;
    },
    signal?: AbortSignal,
  ): Promise<{ messages: ChatHistoryMessage[]; reused: boolean } | null> {
    const cache = this.ports.compactionCache;
    const platform = this.ports.platform;
    const coverage = computeCompactionCoverage(entries);
    if (!cache || !platform || !coverage) {
      const generated = await this.compactHistory(
        entries,
        externalUserId,
        logger,
        signal,
      );
      if (!generated) return null;
      this.recordCompactionUsage(input, externalUserId, generated.completion);
      return { messages: generated.messages, reused: false };
    }

    let cached: Awaited<ReturnType<CompactionCachePort['get']>> = null;
    try {
      cached = await cache.get(externalUserId);
    } catch (error) {
      logger.warn(
        `Compaction cache read failed, regenerating externalUserId=${maskExternalId(
          externalUserId,
        )} error=${errorMessage(error)}`,
      );
    }
    if (
      cached &&
      cached.coverage.count === coverage.count &&
      cached.coverage.hash === coverage.hash
    ) {
      // Cached summaries are untrusted stored content — replay them through
      // the same re-sanitization pipeline as any history entry (#629).
      const clean = sanitizeUntrustedTextForLlm(cached.text, {
        maxChars: MAX_HISTORY_ENTRY_CHARS,
      });
      if (isInjectionSanitizeReason(clean.reason)) {
        logger.warn(
          `Cached compaction summary redacted externalUserId=${maskExternalId(
            externalUserId,
          )} reason=${clean.reason}`,
        );
        this.recordInjection(
          input,
          'history',
          clean.reason ?? 'unknown',
          cached.text,
        );
      }
      if (!clean.text.trim()) return null;
      return {
        messages: [{ role: 'tool_summary', content: clean.text }],
        reused: true,
      };
    }

    const inflightKey = `${externalUserId}:${coverage.count}:${coverage.hash}`;
    let entry = this.compactionInflight.get(inflightKey);
    if (!entry) {
      const controller = new AbortController();
      const promise = this.generateAndCacheSummary(
        cache,
        input,
        entries,
        externalUserId,
        logger,
        coverage,
        controller.signal,
      );
      entry = { promise, controller, waiters: 0 };
      this.compactionInflight.set(inflightKey, entry);
      void promise
        .catch(() => null)
        .finally(() => {
          if (this.compactionInflight.get(inflightKey) === entry) {
            this.compactionInflight.delete(inflightKey);
          }
        });
    }
    entry.waiters++;
    try {
      const generated = signal
        ? await raceWithAbort(entry.promise, signal)
        : await entry.promise;
      return generated ? { messages: generated.messages, reused: false } : null;
    } catch {
      // Caller aborted its own wait (or the shared generation failed) — fall
      // back to truncation. The shared request keeps running for the
      // remaining waiters, if any.
      return null;
    } finally {
      entry.waiters--;
      if (entry.waiters <= 0) entry.controller.abort();
    }
  }

  /**
   * #704 — single shared generation for one dropped prefix: summarize via
   * the LLM, then persist exactly the replayable message (already
   * fact-stripped by `compactHistory`, never the raw model text).
   * Last-writer-wins across pods; a failed write never fails the reply.
   *
   * #703 — records the generation's usage exactly once (a cache hit costs no
   * tokens, so it records nothing).
   */
  private async generateAndCacheSummary(
    cache: CompactionCachePort,
    input: LlmAgentInput,
    entries: ChatHistoryMessage[],
    externalUserId: string,
    logger: {
      warn: (message: string) => void;
      debug: (message: string) => void;
    },
    coverage: CompactionCoverage,
    signal?: AbortSignal,
  ): Promise<CompactionGeneration | null> {
    const generated = await this.compactHistory(
      entries,
      externalUserId,
      logger,
      signal,
    );
    if (!generated) return null;
    this.recordCompactionUsage(input, externalUserId, generated.completion);
    const content = generated.messages[0]?.content;
    if (!content) return null;
    try {
      await cache.set(externalUserId, { text: content, coverage });
    } catch (error) {
      logger.warn(
        `Compaction cache write failed externalUserId=${maskExternalId(
          externalUserId,
        )} error=${errorMessage(error)}`,
      );
    }
    return generated;
  }

  /**
   * #703 — usage for one compaction generation. `toolRound: -1` marks a
   * non-round call so cost rollups never confuse it with a chat round
   * (report callers already use `0` for their own non-round calls — `-1`
   * stays distinct from both real rounds and those). Best-effort: metering
   * must never change the reply path.
   */
  private recordCompactionUsage(
    input: LlmAgentInput,
    externalUserId: string,
    completion: LlmProviderMetadata,
  ): void {
    try {
      this.ports.usageRecorder.recordFromCompletion({
        feature: FEATURE,
        externalUserId,
        userId: input.userId,
        provider: completion.provider,
        model: completion.model,
        response: {
          id: completion.responseId ?? '',
          usage: completion.usage ?? null,
        },
        correlationId: `compaction:${externalUserId}`,
        toolRound: -1,
      });
    } catch (error) {
      const logger = this.ports.logger ?? NOOP_LOGGER;
      logger.warn(
        `Compaction usage record failed externalUserId=${maskExternalId(
          externalUserId,
        )} error=${errorMessage(error)}`,
      );
    }
  }

  /**
   * #413 AC#3 — Strip factual data from compaction summary that should not be
   * treated as authoritative (scores, dates, specific numbers). Returns null
   * if the summary becomes empty after stripping (caller falls back to
   * truncation).
   */
  private sanitizeCompactionSummary(summary: string): string | null {
    const sanitized = summary
      // Band scores: "band 6.0", "6.5 band", "band score 7.0"
      .replace(/\bband\s*\d+\.?\d*\b/gi, '')
      .replace(/\d+\.?\d*\s*band\b/gi, '')
      // IELTS scores: "IELTS 6.5", "6.5 IELTS"
      .replace(/\bielts\s*\d+\.?\d*\b/gi, '')
      .replace(/\d+\.?\d*\s*ielts\b/gi, '')
      // Dates: DD/MM/YYYY, MM/DD/YYYY, YYYY-MM-DD, "ngày 15/3"
      .replace(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g, '')
      .replace(/\b\d{4}[/-]\d{1,2}[/-]\d{1,2}\b/g, '')
      .replace(/ngày\s*\d{1,2}[/-]\d{1,2}/gi, '')
      // Specific scores: "điểm 6.5", "score 7.0", "score: 6.0"
      .replace(/(?:điểm|score|diem)\s*:\s*\d+\.?\d*/gi, '')
      .replace(/\d+\.?\d*\s*(?:điểm|score|diem)/gi, '')
      // Target scores: "target 6.5", "target: 7.0"
      .replace(/\btarget\s*:\s*\d+\.?\d*/gi, '')
      .replace(/\btarget\s+\d+\.?\d*/gi, '')
      // Clean up extra whitespace
      .replace(/\s{2,}/g, ' ')
      .trim();

    if (sanitized.length < 10) {
      return null;
    }
    return sanitized;
  }

  private getMaxInputTokens(): number {
    const v = this.config.maxInputTokens;
    if (v && Number.isFinite(v) && v > 0) return Math.floor(v);
    // Fallback: derive from maxContextChars using token estimation
    const chars = this.getMaxContextChars();
    return Math.floor(chars * 0.67); // ~1.5 tokens/char → 1 char ≈ 0.67 tokens
  }

  private getCompactionEnabled(): boolean {
    return this.config.compactionEnabled === true;
  }

  private getCompactionSummaryMaxTokens(): number {
    const v = this.config.compactionSummaryMaxTokens;
    if (v && Number.isFinite(v) && v > 0) return Math.floor(v);
    return DEFAULT_COMPACTION_SUMMARY_MAX_TOKENS;
  }

  private getCompactionRecentTurns(): number {
    const v = this.config.compactionRecentTurns;
    if (v && Number.isFinite(v) && v > 0) return Math.floor(v);
    return DEFAULT_COMPACTION_RECENT_TURNS;
  }

  private getMaxContextChars(): number {
    return this.config.maxContextChars &&
      Number.isFinite(this.config.maxContextChars) &&
      this.config.maxContextChars > 0
      ? Math.floor(this.config.maxContextChars)
      : DEFAULT_MAX_CONTEXT_CHARS;
  }

  private async withRetry<T>(
    fn: () => Promise<T>,
    round: number,
    logger: { warn: (msg: string) => void },
    signal?: AbortSignal,
  ): Promise<T> {
    const maxRetries = this.getMaxLlmRetries();
    if (maxRetries === 0) {
      // Retries disabled — single attempt, throw the raw error so the outer
      // llmExecution layer (retryWithBackoff) can classify it itself.
      return fn();
    }
    const baseDelay = this.getRetryBaseDelayMs();
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

  private getMaxLlmRetries(): number {
    const v = this.config.maxLlmRetries;
    if (v !== undefined && v !== null && Number.isFinite(v) && v >= 0) {
      return Math.floor(v);
    }
    return DEFAULT_MAX_LLM_RETRIES;
  }

  private getRetryBaseDelayMs(): number {
    const v = this.config.retryBaseDelayMs;
    if (v && Number.isFinite(v) && v > 0) return Math.floor(v);
    return DEFAULT_RETRY_BASE_DELAY_MS;
  }

  private getToolExecutionTimeoutMs(): number {
    const v = this.config.toolExecutionTimeoutMs;
    if (v && Number.isFinite(v) && v > 0) return Math.floor(v);
    return DEFAULT_TOOL_EXECUTION_TIMEOUT_MS;
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

  private getGlobalAgentTimeoutMs(): number {
    const v = this.config.globalAgentTimeoutMs;
    if (v && Number.isFinite(v) && v > 0) return Math.floor(v);
    return DEFAULT_GLOBAL_AGENT_TIMEOUT_MS;
  }

  private getMaxToolRounds(): number {
    return this.config.maxToolRounds &&
      Number.isFinite(this.config.maxToolRounds) &&
      this.config.maxToolRounds > 0
      ? Math.floor(this.config.maxToolRounds)
      : DEFAULT_MAX_TOOL_ROUNDS;
  }

  private getMaxToolCallsPerRound(): number {
    return this.config.maxToolCallsPerRound &&
      Number.isFinite(this.config.maxToolCallsPerRound) &&
      this.config.maxToolCallsPerRound > 0
      ? Math.floor(this.config.maxToolCallsPerRound)
      : DEFAULT_MAX_TOOL_CALLS_PER_ROUND;
  }

  private getMaxOutputTokens(): number {
    return this.config.maxOutputTokens &&
      Number.isFinite(this.config.maxOutputTokens) &&
      this.config.maxOutputTokens > 0
      ? Math.floor(this.config.maxOutputTokens)
      : DEFAULT_MAX_OUTPUT_TOKENS;
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

  /** Detects the model repeating an identical tool call across rounds (stuck loop). */
  private buildToolCallSignature(
    toolCalls: Array<{ name: string; arguments: string }>,
  ): string {
    return toolCalls
      .map((tc) => this.toolCallKey(tc))
      .sort()
      .join('|');
  }

  // ─── Shared helpers for reply() and replyStream() ───────────────────────

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

    if (isAmbiguousMessage(input.userText)) {
      return {
        blocked: true,
        reply: { text: buildClarificationMessage() },
      };
    }

    return null;
  }

  private async buildMessages(
    input: LlmAgentInput,
    signal?: AbortSignal,
  ): Promise<LlmMessage[]> {
    const logger = this.ports.logger ?? NOOP_LOGGER;
    const safeHistory = await this.buildSafeHistory(
      input,
      input.history ?? [],
      input.systemPrompt,
      input.userText,
      input.externalUserId,
      logger,
      signal,
    );

    return [
      {
        role: 'system',
        content: `${input.systemPrompt}\n\n${REASONING_INSTRUCTION}`,
      },
      ...safeHistory.map((entry) => ({
        role:
          entry.role === 'tool_summary' ? ('assistant' as const) : entry.role,
        content: entry.content,
      })),
      { role: 'user', content: input.userText.trim() },
    ];
  }

  /**
   * Executes the round's tool calls with in-round deduplication (#162):
   * identical (name, serialized args) calls execute ONCE and the result is
   * broadcast to every duplicate call id — repeated side-effectful calls
   * (e.g. `precreate_next_exercise`) can never run twice in one round, while
   * the message list stays valid (every tool_calls id gets a tool result).
   */
  private async executeToolCalls(
    toolCalls: Array<{ id: string; name: string; arguments: string }>,
    input: LlmAgentInput,
    toolContext: TToolContext,
    toolsCalledThisTurn: Set<string>,
    observationBudget: number,
    parentSignal?: AbortSignal,
  ): Promise<
    Array<{
      toolCallId: string;
      toolName: string;
      content: string;
      succeeded: boolean;
    }>
  > {
    const logger = this.ports.logger ?? NOOP_LOGGER;
    const metrics = this.ports.metrics ?? NOOP_METRICS_PORT;

    const uniqueByKey = new Map<
      string,
      { id: string; name: string; arguments: string }
    >();
    for (const call of toolCalls) {
      const key = this.toolCallKey(call);
      if (!uniqueByKey.has(key)) {
        uniqueByKey.set(key, call);
      }
    }
    const uniqueCalls = [...uniqueByKey.values()];
    if (uniqueCalls.length !== toolCalls.length) {
      logger.warn(
        `LLM agent deduped ${toolCalls.length - uniqueCalls.length} duplicate tool call(s) in one round externalUserId=${maskExternalId(
          input.externalUserId,
        )}`,
      );
    }

    const resultsByKey = new Map<
      string,
      {
        observation: ReturnType<typeof reduceToolObservation>;
        succeeded: boolean;
      }
    >();

    const executeCall = async (toolCall: (typeof uniqueCalls)[number]) => {
      const toolName = toolCall.name;
      const argsJson = toolCall.arguments || '{}';

      if (!isAgentToolName(toolName)) {
        resultsByKey.set(this.toolCallKey(toolCall), {
          observation: reduceToolObservation({
            toolName,
            error: 'Tool không được hỗ trợ',
            ok: false,
            maxChars: 8_000,
          }),
          succeeded: false,
        });
        return;
      }

      const validation = parseAndValidateToolArguments(toolName, argsJson);
      if (!validation.ok) {
        metrics.toolPolicyDeniedInc?.(toolName, 'invalid_arguments');
        resultsByKey.set(this.toolCallKey(toolCall), {
          observation: reduceToolObservation({
            toolName,
            error: validation.error,
            ok: false,
            maxChars: 8_000,
          }),
          succeeded: false,
        });
        return;
      }

      if (!getAgentToolDefinition(toolName)?.capability) {
        metrics.toolPolicyDeniedInc?.(toolName, 'missing_capability');
        resultsByKey.set(this.toolCallKey(toolCall), {
          observation: reduceToolObservation({
            toolName,
            error: 'Tool execution blocked by policy',
            ok: false,
            maxChars: 8_000,
          }),
          succeeded: false,
        });
        return;
      }

      toolsCalledThisTurn.add(toolName);

      const controller = new AbortController();
      const abort = () => controller.abort();
      parentSignal?.addEventListener('abort', abort, { once: true });
      try {
        const result = await withTimeout(
          metrics.timeTool(toolName, () =>
            this.ports.toolExecutor.execute(
              toolName,
              argsJson,
              toolContext,
              controller.signal,
            ),
          ),
          this.getToolExecutionTimeoutMs(),
          `Tool ${toolName}`,
          () => controller.abort(),
        );
        resultsByKey.set(this.toolCallKey(toolCall), {
          observation: reduceToolObservation({
            toolName,
            result,
            ok: true,
            maxChars: 8_000,
          }),
          succeeded: true,
        });
      } catch (err) {
        const message = maskExternalIdInText(
          sanitizeUntrustedTextForLlm(errorMessage(err), {
            maxChars: 500,
            unsafePlaceholder: 'Tool execution failed',
          }).text,
          input.externalUserId,
        );
        logger.warn(
          `Tool execution failed externalUserId=${maskExternalId(
            input.externalUserId,
          )} tool=${toolName} error=${message}`,
        );
        resultsByKey.set(this.toolCallKey(toolCall), {
          observation: reduceToolObservation({
            toolName,
            error: message,
            ok: false,
            maxChars: 8_000,
          }),
          succeeded: false,
        });
      } finally {
        parentSignal?.removeEventListener('abort', abort);
      }
    };

    const hasSideEffect = uniqueCalls.some(
      (call) =>
        getAgentToolDefinition(call.name)?.capability.effect !== 'read_only',
    );
    if (!hasSideEffect) {
      await Promise.all(uniqueCalls.map((call) => executeCall(call)));
    } else {
      // Preserve the model's dependency order whenever a side effect is
      // present; all side effects are therefore serialized as well.
      for (const call of uniqueCalls) {
        await executeCall(call);
      }
    }

    // Build one bounded, sanitized observation per executed call. The full
    // form is only retained for this small round (the call cap is four), then
    // allocated in model order so every call retains at least a marker.
    const fullByKey = new Map<
      string,
      ReturnType<typeof reduceToolObservation>
    >();
    for (const call of uniqueCalls) {
      const result = resultsByKey.get(this.toolCallKey(call)) ?? {
        observation: this.missingToolExecutionObservation(call.name),
        succeeded: false,
      };
      fullByKey.set(this.toolCallKey(call), result.observation);
      // #629 — a learner-authored upstream field carried an injection payload
      // that `sanitizeToolResultContent` neutralized; meter it before the
      // observation is allocated into the message list.
      const injection = result.observation.injection;
      if (injection) {
        logger.warn(
          `Tool result injection neutralized externalUserId=${maskExternalId(
            input.externalUserId,
          )} tool=${call.name} reason=${injection.reason}`,
        );
        this.recordInjection(
          input,
          'tool_result',
          injection.reason,
          injection.rawPreview,
          call.name,
        );
      }
    }

    const minimumMarkerBudget = toolCalls.reduce((sum, call) => {
      const execution = resultsByKey.get(this.toolCallKey(call));
      return (
        sum +
        observationMarker('truncated', execution?.succeeded ?? false).length
      );
    }, 0);
    let extraBudget = Math.max(0, observationBudget - minimumMarkerBudget);
    let remainingUnique = uniqueCalls.length;
    const emittedObservationKeys = new Set<string>();
    const allocatedByKey = new Map<string, string>();
    const outcomesByKey = new Map<string, ToolObservationOutcome>();

    for (const call of toolCalls) {
      const callKey = this.toolCallKey(call);
      const full = fullByKey.get(callKey);
      const execution = resultsByKey.get(callKey) ?? {
        observation: this.missingToolExecutionObservation(call.name),
        succeeded: false,
      };
      // A lossy projection/truncation is not strong identity: distinct calls
      // can share the retained prefix. Exact duplicate calls still share the
      // same callKey and can safely reuse their observation.
      const observationKey = `${call.name}:${
        full?.wasTruncated ? `call:${callKey}` : (full?.canonical ?? callKey)
      }`;

      if (emittedObservationKeys.has(observationKey)) {
        allocatedByKey.set(
          `${call.id}:${callKey}`,
          observationMarker('reused', execution.succeeded),
        );
        outcomesByKey.set(`${call.id}:${callKey}`, 'deduped');
        continue;
      }

      emittedObservationKeys.add(observationKey);
      remainingUnique = Math.max(1, remainingUnique);
      const markerLength = observationMarker(
        'truncated',
        execution.succeeded,
      ).length;
      const allocation = Math.max(
        markerLength,
        markerLength + Math.floor(extraBudget / remainingUnique),
      );
      const fitted = full
        ? fitToolObservation(full.content, allocation)
        : {
            content: observationMarker(
              execution.succeeded ? 'truncated' : 'fallback',
              execution.succeeded,
            ),
            wasTruncated: true,
          };
      const content = fitted.content;
      const outcome: ToolObservationOutcome =
        full?.outcome === 'fallback'
          ? 'fallback'
          : full?.wasTruncated || fitted.wasTruncated
            ? 'truncated'
            : 'kept';
      allocatedByKey.set(`${call.id}:${callKey}`, content);
      outcomesByKey.set(`${call.id}:${callKey}`, outcome);
      extraBudget = Math.max(
        0,
        extraBudget - Math.max(0, content.length - markerLength),
      );
      remainingUnique -= 1;
    }

    // Every original call id gets a tool message, including duplicates. This
    // preserves provider pairing while duplicate observations stay compact.
    return toolCalls.map((call) => {
      const result = resultsByKey.get(this.toolCallKey(call)) ?? {
        observation: this.missingToolExecutionObservation(call.name),
        succeeded: false,
      };
      const resultKey = `${call.id}:${this.toolCallKey(call)}`;
      const outcome = outcomesByKey.get(resultKey) ?? 'fallback';
      const content =
        allocatedByKey.get(resultKey) ??
        observationMarker('fallback', result.succeeded);
      const metricToolName = isAgentToolName(call.name) ? call.name : 'unknown';
      metrics.observationOutcomeInc?.(metricToolName, outcome);
      return {
        toolCallId: call.id,
        toolName: call.name,
        content,
        succeeded: result.succeeded,
      };
    });
  }

  private toolCallKey(call: { name: string; arguments: string }): string {
    const validated = parseAndValidateToolArguments(
      call.name,
      call.arguments || '{}',
    );
    return `${call.name}:${validated.ok ? validated.canonicalArgs : call.arguments || '{}'}`;
  }

  private missingToolExecutionObservation(
    toolName: string,
  ): ReturnType<typeof reduceToolObservation> {
    return reduceToolObservation({
      toolName,
      error: 'tool execution did not produce a result',
      ok: false,
      maxChars: 8_000,
    });
  }

  private countUniqueToolCalls(
    toolCalls: Array<{ name: string; arguments: string }>,
  ): number {
    return new Set(toolCalls.map((call) => this.toolCallKey(call))).size;
  }
}
