import type { LlmAgentConfig } from '../types';
import {
  DEFAULT_LLM_MAX_TOTAL_PROVIDER_ATTEMPTS,
  normalizeMaxTotalProviderAttempts,
} from '../execution/attempt-budget';

const DEFAULT_MAX_TOOL_ROUNDS = 6;
const DEFAULT_MAX_TOOL_CALLS_PER_ROUND = 4;
const DEFAULT_MAX_TOOL_EXECUTIONS_PER_TURN = 8;
const DEFAULT_MAX_TOOL_RUNS_PER_NAME_PER_TURN = 3;
const DEFAULT_STALE_OBSERVATION_ROUNDS = 2;
const DEFAULT_MAX_CONTEXT_CHARS = 24_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 1024;
export const DEFAULT_TOOL_EXECUTION_TIMEOUT_MS = 10_000;
const DEFAULT_GLOBAL_AGENT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_LLM_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 100;

/**
 * Shared, conservative text estimate used by every context decision.
 * It is deliberately tokenizer-free: provider tokenizers are not available
 * in this framework-agnostic package.
 */
export function estimateTokens(text: string): number {
  // Vietnamese diacritics and CJK consume more bytes/tokens than ASCII.
  // eslint-disable-next-line no-control-regex
  const nonAscii = (text.match(/[^\x00-\x7F]/g) ?? []).length;
  const ascii = text.length - nonAscii;
  return Math.ceil(nonAscii * 1.5 + ascii * 0.75);
}

function positive(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : fallback;
}

function nonNegative(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

export class AgentLimits {
  readonly maxToolRounds: number;
  readonly maxToolCallsPerRound: number;
  readonly maxToolExecutionsPerTurn: number;
  readonly maxToolRunsPerNamePerTurn: number;
  readonly staleObservationRounds: number;
  readonly maxContextChars: number;
  readonly maxLlmRetries: number;
  readonly maxTotalProviderAttempts: number;
  readonly retryBaseDelayMs: number;
  readonly maxOutputTokens: number;
  readonly toolExecutionTimeoutMs: number;
  readonly globalAgentTimeoutMs: number;
  readonly inputTokenBudget: number;

  constructor(config: LlmAgentConfig = {}) {
    this.maxToolRounds = positive(
      config.maxToolRounds,
      DEFAULT_MAX_TOOL_ROUNDS,
    );
    this.maxToolCallsPerRound = positive(
      config.maxToolCallsPerRound,
      DEFAULT_MAX_TOOL_CALLS_PER_ROUND,
    );
    this.maxToolExecutionsPerTurn = positive(
      config.maxToolExecutionsPerTurn,
      DEFAULT_MAX_TOOL_EXECUTIONS_PER_TURN,
    );
    this.maxToolRunsPerNamePerTurn = positive(
      config.maxToolRunsPerNamePerTurn,
      DEFAULT_MAX_TOOL_RUNS_PER_NAME_PER_TURN,
    );
    this.staleObservationRounds = positiveInteger(
      config.staleObservationRounds,
      DEFAULT_STALE_OBSERVATION_ROUNDS,
    );
    this.maxContextChars = positive(
      config.maxContextChars,
      DEFAULT_MAX_CONTEXT_CHARS,
    );
    this.maxLlmRetries = nonNegative(
      config.maxLlmRetries,
      DEFAULT_MAX_LLM_RETRIES,
    );
    this.maxTotalProviderAttempts = normalizeMaxTotalProviderAttempts(
      config.maxTotalProviderAttempts ??
        DEFAULT_LLM_MAX_TOTAL_PROVIDER_ATTEMPTS,
    );
    this.retryBaseDelayMs = positive(
      config.retryBaseDelayMs,
      DEFAULT_RETRY_BASE_DELAY_MS,
    );
    this.maxOutputTokens = positive(
      config.maxOutputTokens,
      DEFAULT_MAX_OUTPUT_TOKENS,
    );
    this.toolExecutionTimeoutMs = positive(
      config.toolExecutionTimeoutMs,
      DEFAULT_TOOL_EXECUTION_TIMEOUT_MS,
    );
    this.globalAgentTimeoutMs = positive(
      config.globalAgentTimeoutMs,
      DEFAULT_GLOBAL_AGENT_TIMEOUT_MS,
    );

    const configuredInputTokens =
      config.maxInputTokens !== undefined &&
      Number.isFinite(config.maxInputTokens) &&
      config.maxInputTokens > 0 &&
      Math.floor(config.maxInputTokens) > 0
        ? Math.floor(config.maxInputTokens)
        : undefined;
    this.inputTokenBudget =
      configuredInputTokens ?? Math.floor(this.maxContextChars * 0.67);
  }

  /** Conservative character ceiling for bounded tool observations. */
  observationCharBudget(usedTokens: number): number {
    const remaining = Math.max(0, this.inputTokenBudget - usedTokens);
    return Math.floor(remaining / 0.75);
  }
}
