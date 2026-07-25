export interface LlmExecutionPort {
  run<T>(
    fn: () => Promise<T>,
    meta: { feature: string; correlationId?: string },
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
}

/** Executes a single tool call against platform-specific business services. */
export interface ToolExecutorPort<TToolContext> {
  execute(
    toolName: string,
    argsJson: string,
    context: TToolContext,
  ): Promise<unknown>;
}

export const NOOP_METRICS_PORT: AgentMetricsPort = {
  timeLlmCall: (_feature, _model, _round, fn) => fn(),
  timeTool: (_toolName, fn) => fn(),
  llmRoundOutcomeInc: () => undefined,
  timeAgentLoop: (_feature, fn) => fn(),
};
