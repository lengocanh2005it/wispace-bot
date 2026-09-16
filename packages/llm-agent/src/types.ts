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
  /**
   * Max total tool executions in one turn, accumulated across rounds (#962).
   * Exhausting it ends the turn with the exhaustion partial answer instead
   * of another LLM round. Default: 8.
   */
  maxToolExecutionsPerTurn?: number;
  /**
   * Times one tool may run in a single turn before varied-argument looping
   * is declared (#962) — identical-argument loop detection cannot catch
   * `pastDays:30` → `pastDays:31` probes. Default: 3.
   */
  maxToolRunsPerNamePerTurn?: number;
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
  /** Max input-token budget (system, tools, history, user, and loop messages). */
  maxInputTokens?: number;
}

/** Named chat prompt parts used by the context budget policy. */
export interface LlmAgentPromptParts {
  core: string;
  overlay: string;
  identityDisplayName?: string | null;
  learnerProfile?: string | null;
}

export interface LlmAgentInput {
  /** Platform-specific user id (psid, discord user id, zalo uid...) — used for logging/telemetry only. */
  externalUserId: string;
  /** WISPACE userId if the external account is linked; undefined otherwise. */
  userId?: number;
  userText: string;
  /** Fully-built system prompt (base persona + per-user linkage note) — composed by the caller. */
  systemPrompt: string;
  /** Optional named parts; when present they are the source of truth for context trimming. */
  systemPromptParts?: LlmAgentPromptParts;
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
   * Bounded advisory summary of tools invoked this turn and deterministic
   * structured outcomes (e.g. "[Đã tra cứu: tool1; tool2]"). Present only
   * when at least one tool was called. Callers should persist this as a
   * `tool_summary` history entry; it never replaces fresh tool data for
   * personal-data answers.
   */
  toolSummary?: string;
}
