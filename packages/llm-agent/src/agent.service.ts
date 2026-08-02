import type { LlmProviderAdapter } from './provider/llm-provider.adapter';
import type { LlmMessage } from './provider/types';
import { AGENT_TOOLS } from './agent.tools';
import { checkLlmGrounding } from './utils/llm-grounding.utils';
import {
  detectPromptInjection,
  sanitizeToolResultContent,
} from './utils/prompt-injection.utils';
import { isObviouslyOffTopic } from './utils/scope.utils';
import { sanitizeReplyText } from './utils/text.utils';
import {
  buildPromptInjectionBlockedMessage,
  buildWispaceScopeRedirectMessage,
  buildGroundingBlockedMessage,
} from './messages';
import {
  AgentMetricsPort,
  LlmExecutionPort,
  LlmSafetyEventPort,
  LlmUsageRecorderPort,
  NOOP_METRICS_PORT,
  ToolExecutorPort,
} from './ports';
import type {
  ChatHistoryMessage,
  LlmAgentConfig,
  LlmAgentInput,
  LlmAgentReply,
  LlmAgentStreamEvent,
} from './types';

const DEFAULT_MAX_TOOL_ROUNDS = 6;
const DEFAULT_MAX_CONTEXT_CHARS = 24_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 1024;
const DEFAULT_TOOL_EXECUTION_TIMEOUT_MS = 10_000;
const DEFAULT_GLOBAL_AGENT_TIMEOUT_MS = 60_000;
const FEATURE = 'FREE_FORM_CHAT';

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
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
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

/**
 * Framework-agnostic LLM function-calling orchestration loop, shared across
 * all WISPACE bot platforms. Tool business logic (Wispace API calls, DB reads...)
 * is NOT part of this class — it lives behind `ToolExecutorPort`, implemented per app.
 *
 * The LLM provider is injected via `LlmProviderAdapter` — no direct SDK dependency.
 */
export class LlmAgentService<TToolContext> {
  constructor(
    private readonly config: LlmAgentConfig,
    private readonly ports: LlmAgentPorts<TToolContext>,
  ) {}

  async reply(
    input: LlmAgentInput,
    toolContext: TToolContext,
  ): Promise<LlmAgentReply> {
    return withTimeout(
      this.ports.metrics?.timeAgentLoop
        ? this.ports.metrics.timeAgentLoop(FEATURE, () =>
            this.collectReply(input, toolContext),
          )
        : this.collectReply(input, toolContext),
      this.getGlobalAgentTimeoutMs(),
      'Agent loop',
    );
  }

  /** Runs the agent loop and returns the final reply (throws on error). */
  private async collectReply(
    input: LlmAgentInput,
    toolContext: TToolContext,
  ): Promise<LlmAgentReply> {
    let reply: LlmAgentReply | undefined;
    for await (const event of this.runRounds(input, toolContext)) {
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
    for await (const event of this.runRounds(input, toolContext)) {
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
      yield { type: 'done', reply: earlyReturn.reply };
      return;
    }

    const model = adapter.getDefaultModel();
    const messages = this.buildMessages(input);

    const toolsCalledThisTurn = new Set<string>();
    const maxToolRounds = this.getMaxToolRounds();
    let previousToolCallSignature: string | null = null;

    for (let round = 0; round < maxToolRounds; round++) {
      try {
        const response = await metrics.timeLlmCall(FEATURE, model, round, () =>
          this.ports.llmExecution.run(
            () =>
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
                  }),
                round,
                logger,
              ),
            { feature: FEATURE, correlationId: input.correlationId },
          ),
        );

        this.ports.usageRecorder.recordFromCompletion({
          feature: FEATURE,
          externalUserId: input.externalUserId,
          userId: input.userId,
          model,
          response: {
            id: response.metadata.responseId ?? '',
            usage: response.metadata.usage
              ? {
                  prompt_tokens: response.metadata.usage.promptTokens,
                  completion_tokens: response.metadata.usage.completionTokens,
                  total_tokens: response.metadata.usage.totalTokens,
                  prompt_tokens_details:
                    response.metadata.usage.cachedTokens !== undefined
                      ? { cached_tokens: response.metadata.usage.cachedTokens }
                      : undefined,
                }
              : null,
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

          const groundingCheck = checkLlmGrounding(text, toolsCalledThisTurn);
          if (groundingCheck.suspicious) {
            logger.warn(
              `LLM_GROUNDING_WARNING feature=${FEATURE} externalUserId=${input.externalUserId} reason=${groundingCheck.reason} tools_called=${[...toolsCalledThisTurn].join(',') || 'none'}`,
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
          yield {
            type: 'final_text',
            text: sanitized,
            reply: { text: sanitized, toolSummary },
          };
          return;
        }

        const signature = this.buildToolCallSignature(toolCalls);
        if (signature === previousToolCallSignature) {
          metrics.llmRoundOutcomeInc(FEATURE, 'duplicate_tool_calls');
          logger.warn(
            `LLM agent detected duplicate tool calls, stopping early round=${round} externalUserId=${input.externalUserId} tools_called=${[...toolsCalledThisTurn].join(',') || 'none'}`,
          );
          break;
        }
        previousToolCallSignature = signature;

        metrics.llmRoundOutcomeInc(FEATURE, 'tool_call');
        messages.push(response.message);

        // Emit tool_start for all calls before parallel execution
        for (const toolCall of toolCalls) {
          toolsCalledThisTurn.add(toolCall.name);
          yield { type: 'tool_start', toolName: toolCall.name };
        }

        const toolResults = await this.executeToolCalls(
          toolCalls,
          input,
          toolContext,
          toolsCalledThisTurn,
        );

        for (const result of toolResults) {
          messages.push({
            role: 'tool',
            toolCallId: result.toolCallId,
            content: result.content,
          });
        }
      } catch (err) {
        yield { type: 'error', error: err };
        return;
      }
    }

    // Exhausted all rounds without a final text reply
    metrics.llmRoundOutcomeInc(FEATURE, 'exhausted');
    logger.warn(
      `LLM agent exhausted maxToolRounds=${this.getMaxToolRounds()} externalUserId=${input.externalUserId} tools_called=${[...toolsCalledThisTurn].join(',') || 'none'}`,
    );
    const toolList = [...toolsCalledThisTurn].join(', ') || 'không có';
    const toolSummary =
      toolsCalledThisTurn.size > 0
        ? `[Đã tra cứu: ${[...toolsCalledThisTurn].join('; ')}]`
        : undefined;
    yield {
      type: 'done',
      reply: {
        text: `Trợ lý đã tra cứu thông tin (${toolList}) nhưng chưa thể tổng hợp kết quả. Bạn vui lòng thử lại hoặc đặt câu hỏi cụ thể hơn nhé.`,
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
   * Fix 2 — redact history entries containing injection patterns.
   * Fix 3 — truncate history to stay within context token budget.
   */
  private buildSafeHistory(
    history: ChatHistoryMessage[],
    systemPrompt: string,
    userText: string,
    externalUserId: string,
    logger: {
      warn: (message: string) => void;
      debug: (message: string) => void;
    },
  ): ChatHistoryMessage[] {
    const redacted = history.map((entry) => {
      const check = detectPromptInjection(entry.content);
      if (check.isInjection) {
        logger.warn(
          `History entry redacted externalUserId=${externalUserId} reason=${check.reason}`,
        );
        return { ...entry, content: '[redacted]' };
      }
      return entry;
    });

    const maxTokens = this.getMaxInputTokens();
    const fixedTokens = estimateTokens(systemPrompt) + estimateTokens(userText);
    let budget = maxTokens - fixedTokens;

    const result: ChatHistoryMessage[] = [];
    for (let i = redacted.length - 1; i >= 0; i--) {
      const entry = redacted[i];
      if (!entry) continue;
      const entryTokens = estimateTokens(entry.content);
      if (budget >= entryTokens) {
        result.unshift(entry);
        budget -= entryTokens;
      } else {
        logger.debug(
          `History truncated at index ${i} to stay within token budget externalUserId=${externalUserId}`,
        );
        break;
      }
    }

    return result;
  }

  private getMaxInputTokens(): number {
    const v = this.config.maxInputTokens;
    if (v && Number.isFinite(v) && v > 0) return Math.floor(v);
    // Fallback: derive from maxContextChars using token estimation
    const chars = this.getMaxContextChars();
    return Math.floor(chars * 0.67); // ~1.5 tokens/char → 1 char ≈ 0.67 tokens
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
  ): Promise<T> {
    const maxRetries = this.getMaxLlmRetries();
    const baseDelay = this.getRetryBaseDelayMs();
    let lastErr: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (
          !this.ports.adapter.isRetryableError(err) ||
          attempt === maxRetries
        ) {
          break;
        }
        const delay = Math.min(
          baseDelay * Math.pow(2, attempt) * (0.5 + Math.random() * 0.5),
          MAX_RETRY_DELAY_MS,
        );
        logger.warn(
          `LLM_RETRY attempt=${attempt + 1}/${maxRetries} round=${round} delay=${Math.round(delay)}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw new LlmRetryExhaustedError(maxRetries + 1, lastErr);
  }

  private getMaxLlmRetries(): number {
    const v = this.config.maxLlmRetries;
    if (v && Number.isFinite(v) && v > 0) return Math.floor(v);
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

  private getMaxOutputTokens(): number {
    return this.config.maxOutputTokens &&
      Number.isFinite(this.config.maxOutputTokens) &&
      this.config.maxOutputTokens > 0
      ? Math.floor(this.config.maxOutputTokens)
      : DEFAULT_MAX_OUTPUT_TOKENS;
  }

  /** Detects the model repeating an identical tool call across rounds (stuck loop). */
  private buildToolCallSignature(
    toolCalls: Array<{ name: string; arguments: string }>,
  ): string {
    return toolCalls
      .map((tc) => `${tc.name}:${tc.arguments}`)
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
        `Prompt injection blocked externalUserId=${input.externalUserId} reason=${injectionCheck.reason}`,
      );
      return {
        blocked: true,
        reply: { text: buildPromptInjectionBlockedMessage() },
      };
    }

    if (isObviouslyOffTopic(input.userText)) {
      return {
        blocked: true,
        reply: { text: buildWispaceScopeRedirectMessage() },
      };
    }

    return null;
  }

  private buildMessages(input: LlmAgentInput): LlmMessage[] {
    const logger = this.ports.logger ?? NOOP_LOGGER;
    const safeHistory = this.buildSafeHistory(
      input.history ?? [],
      input.systemPrompt,
      input.userText,
      input.externalUserId,
      logger,
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

  private async executeToolCalls(
    toolCalls: Array<{ id: string; name: string; arguments: string }>,
    input: LlmAgentInput,
    toolContext: TToolContext,
    toolsCalledThisTurn: Set<string>,
  ): Promise<Array<{ toolCallId: string; content: string }>> {
    const logger = this.ports.logger ?? NOOP_LOGGER;
    const metrics = this.ports.metrics ?? NOOP_METRICS_PORT;

    return Promise.all(
      toolCalls.map(async (toolCall) => {
        const toolName = toolCall.name;
        toolsCalledThisTurn.add(toolName);
        const argsJson = toolCall.arguments || '{}';

        let content: string;
        try {
          const result = await withTimeout(
            metrics.timeTool(toolName, () =>
              this.ports.toolExecutor.execute(toolName, argsJson, toolContext),
            ),
            this.getToolExecutionTimeoutMs(),
            `Tool ${toolName}`,
          );
          const raw = JSON.stringify({ ok: true, data: result });
          const sanitized = sanitizeToolResultContent(raw);
          if (sanitized.wasSanitized) {
            logger.warn(
              `Tool result sanitized externalUserId=${input.externalUserId} tool=${toolName} reason=${sanitized.reason}`,
            );
          }
          content = sanitized.content;
        } catch (err) {
          const message = err instanceof Error ? err.message : 'unknown error';
          logger.warn(
            `Tool execution failed externalUserId=${input.externalUserId} tool=${toolName} error=${message}`,
          );
          content = JSON.stringify({ ok: false, error: message });
        }

        return { toolCallId: toolCall.id, content };
      }),
    );
  }
}
