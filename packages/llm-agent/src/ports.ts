export interface LlmExecutionPort {
  /**
   * Runs an LLM call through the configured execution-control path (limiter,
   * deadline, retry). `fn` receives the composed signal (caller signal merged
   * with the execution deadline) and MUST pass it to the underlying provider
   * request so a timeout/cancellation aborts the in-flight call, not just the
   * wrapper promise. `meta.signal` is the caller's cancellation signal.
   */
  run<T>(
    fn: (signal?: AbortSignal) => Promise<T>,
    meta: { feature: string; correlationId?: string; signal?: AbortSignal },
  ): Promise<T>;
}

export interface LlmUsageRecorderPort {
  recordFromCompletion(params: {
    feature: string;
    externalUserId: string;
    userId?: number;
    provider?: string;
    model: string;
    /** Provider-neutral completion snapshot — usage is already `LlmUsage` (#427). */
    response: { id: string; usage?: LlmUsage | null };
    correlationId?: string;
    toolRound: number;
  }): void;
}

/** Where a neutralized prompt-injection payload came from (#629). */
export type LlmInjectionSource = 'user_input' | 'tool_result' | 'history';

export interface LlmSafetyEventPort {
  recordGroundingWarning(params: {
    externalUserId: string;
    userId?: number;
    correlationId?: string;
    reason: string;
    userTextPreview: string;
    assistantTextPreview: string;
    toolNamesUsed: string[];
  }): void;
  /**
   * A prompt-injection pattern was detected and neutralized before it reached
   * model context (#629). `textPreview` is the offending pre-sanitization
   * text — the implementer redacts it to an excerpt/hash before persisting,
   * never stores it raw (#122).
   */
  recordInjectionEvent(params: {
    externalUserId: string;
    userId?: number;
    correlationId?: string;
    source: LlmInjectionSource;
    reason: string;
    textPreview: string;
    toolName?: string;
  }): void;
}

export type LlmRoundOutcome =
  | 'direct_reply'
  | 'tool_call'
  | 'exhausted'
  | 'duplicate_tool_calls';

export type LlmDegradedFailureClass =
  | 'provider_unconfigured'
  | 'provider_exhausted'
  | 'provider_circuit_open'
  | 'execution_overload'
  | 'timeout'
  | 'tool_failure'
  | 'tool_round_exhausted'
  | 'invalid_output'
  | 'grounding_blocked'
  | 'safety_blocked'
  | 'upstream_unavailable'
  | 'no_score_data'
  | 'history_unavailable'
  | 'queue_failure'
  | 'outbound_failure'
  | 'unknown';

export type LlmDegradedAction =
  | 'chat_fallback'
  | 'partial_answer'
  | 'block_response'
  | 'report_fallback'
  | 'report_retry'
  | 'report_unavailable'
  | 'reminder_fallback'
  | 'durable_retry'
  | 'continue_with_partial_data'
  | 'unknown';

/**
 * Context for a degraded/fallback response. The metric adapter must use only
 * the bounded fields as labels; correlationId is for structured logs/traces.
 */
export interface LlmDegradedModeEvent {
  platform: string;
  feature: string;
  failureClass: LlmDegradedFailureClass;
  action: LlmDegradedAction;
  correlationId?: string;
}

export interface AgentMetricsPort {
  timeLlmCall<T>(
    feature: string,
    model: string,
    round: number,
    fn: () => Promise<T>,
  ): Promise<T>;
  timeTool<T>(toolName: string, fn: () => Promise<T>): Promise<T>;
  llmRoundOutcomeInc(feature: string, outcome: LlmRoundOutcome): void;
  /** Time the entire agent loop (all rounds). Optional — noop if not provided. */
  timeAgentLoop?<T>(feature: string, fn: () => Promise<T>): Promise<T>;
  /** #413: Record compaction outcome. Optional — noop if not provided. */
  compactionOutcomeInc?(outcome: 'compacted' | 'fallback' | 'skipped'): void;
  /** #414: Record bounded in-run tool-observation outcomes. */
  observationOutcomeInc?(
    toolName: string,
    outcome: ToolObservationOutcome,
  ): void;
  /** Bounded policy-denial telemetry; never receives raw arguments or ids. */
  toolPolicyDeniedInc?(toolName: string, reason: string): void;
  /** Degraded/fallback telemetry; correlationId must never become a metric label. */
  degradedModeInc?(event: LlmDegradedModeEvent): void;
  /** #629: a prompt-injection payload was neutralized. `source` is a bounded label. */
  injectionBlockedInc?(source: LlmInjectionSource): void;
  /** #649: an LLM input-classifier verdict. `label` and `mode` are bounded labels. */
  classifierVerdictInc?(label: string, mode: 'shadow' | 'enforce'): void;
}

/** Executes a single tool call against platform-specific business services. */
export interface ToolExecutorPort<TToolContext> {
  execute(
    toolName: string,
    argsJson: string,
    context: TToolContext,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

export const NOOP_METRICS_PORT: AgentMetricsPort = {
  timeLlmCall: (_feature, _model, _round, fn) => fn(),
  timeTool: (_toolName, fn) => fn(),
  llmRoundOutcomeInc: () => undefined,
  timeAgentLoop: (_feature, fn) => fn(),
  compactionOutcomeInc: () => undefined,
  observationOutcomeInc: () => undefined,
  toolPolicyDeniedInc: () => undefined,
  degradedModeInc: () => undefined,
  injectionBlockedInc: () => undefined,
  classifierVerdictInc: () => undefined,
};
import type { LlmUsage } from './provider/types';
import type { ToolObservationOutcome } from './utils/tool-observation';
