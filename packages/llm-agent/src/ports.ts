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
    model: string;
    response: unknown;
    correlationId?: string;
    toolRound: number;
  }): void;
}

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
}

export type LlmRoundOutcome =
  | 'direct_reply'
  | 'tool_call'
  | 'exhausted'
  | 'duplicate_tool_calls';

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
};
import type { ToolObservationOutcome } from './utils/tool-observation';
