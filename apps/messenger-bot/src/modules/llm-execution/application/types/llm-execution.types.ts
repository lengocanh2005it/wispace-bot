export type LlmExecutionFeature =
  | 'FREE_FORM_CHAT'
  | 'STUDENT_REPORT'
  | 'STUDY_REMINDER';

export interface LlmExecutionContext {
  feature: LlmExecutionFeature;
  correlationId?: string;
  /** Optional caller signal — aborts the LLM call (and stops retries) immediately. */
  signal?: AbortSignal;
}
