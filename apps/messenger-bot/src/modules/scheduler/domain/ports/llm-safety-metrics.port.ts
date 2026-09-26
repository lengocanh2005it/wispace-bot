export const LLM_SAFETY_METRICS = Symbol('LLM_SAFETY_METRICS');

/** Safety telemetry reads the ops-health snapshot needs; no persistence. */
export interface LlmSafetyMetricsPort {
  countWarnings24h(): Promise<number>;
  readWarningDailyThreshold(): number;
}
