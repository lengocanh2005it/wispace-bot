import type { ChatHistoryMessage } from '@wispace/chat-history';
export type { ChatHistoryMessage };

export interface LlmAgentConfig {
  model?: string;
  /** Max tool rounds before the agent gives up. Default: 6. */
  maxToolRounds?: number;
  /**
   * Max DISTINCT (tool, args) executions allowed per model round before the
   * round is blocked fail-closed (#162). Default: 4.
   */
  maxToolCallsPerRound?: number;
  maxContextChars?: number;
  /** Max LLM call retries on retryable errors. Default: 3. */
  maxLlmRetries?: number;
  /** Base delay for retry backoff in ms. Default: 100. */
  retryBaseDelayMs?: number;
  /** Cap on completion tokens per LLM call, to bound cost on runaway output. Default: 1024. */
  maxOutputTokens?: number;
  /** Timeout for individual tool execution in ms. Default: 10_000 (10s). */
  toolExecutionTimeoutMs?: number;
  /** Global timeout for the entire agent loop (all rounds) in ms. Default: 60_000 (60s). */
  globalAgentTimeoutMs?: number;
  /** Max input tokens (system prompt + history + user text). Default: 16_000. */
  maxInputTokens?: number;
}

export interface LlmAgentInput {
  /** Platform-specific user id (psid, discord user id, zalo uid...) — used for logging/telemetry only. */
  externalUserId: string;
  /** WISPACE userId if the external account is linked; undefined otherwise. */
  userId?: number;
  userText: string;
  /** Fully-built system prompt (base persona + per-user linkage note) — composed by the caller. */
  systemPrompt: string;
  history?: ChatHistoryMessage[];
  /** Correlation id (e.g. platform message id) for LLM usage telemetry. */
  correlationId?: string;
  /** Optional signal to cancel the entire agent loop when caller times out or disconnects. */
  signal?: AbortSignal;
}

export interface LlmAgentReply {
  text: string;
  /** True when the agent exhausted maxToolRounds without reaching a final reply. */
  exhausted?: boolean;
  /**
   * Human-readable summary of tools invoked this turn (e.g. "[Đã tra cứu: tool1; tool2]").
   * Present only when at least one tool was called. Callers should persist this as a
   * `tool_summary` history entry so the model knows what it looked up in previous turns.
   */
  toolSummary?: string;
}

/**
 * Events emitted by `LlmAgentService.replyStream()`.
 * - `delta` — incremental text token from the final LLM reply round.
 * - `tool_start` — a tool call is about to be executed (non-streaming round).
 * - `done` — stream complete; full reply is in `reply`.
 * - `error` — unrecoverable error; stream terminates after this event.
 */
export type LlmAgentStreamEvent =
  | { type: 'delta'; textDelta: string }
  | { type: 'tool_start'; toolName: string }
  | { type: 'done'; reply: LlmAgentReply }
  | { type: 'error'; error: unknown };

/**
 * Callbacks for the shared `execute()` algorithm.
 * - `reply()` passes throw-based callbacks.
 * - `replyStream()` passes yield-based callbacks.
 */
export interface LlmAgentExecuteCallbacks {
  /** Called with the final sanitized text before returning. */
  onReply?(reply: LlmAgentReply): void;
  /** Called when a tool call is about to be executed. */
  onToolStart?(toolName: string): void;
  /** Called on unrecoverable errors (empty content, retry exhaustion). */
  onError?(error: Error): void;
}
