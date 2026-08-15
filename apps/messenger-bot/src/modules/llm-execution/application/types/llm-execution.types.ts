export type LlmExecutionFeature =
  | 'FREE_FORM_CHAT'
  | 'STUDENT_REPORT'
  | 'STUDY_REMINDER';

export interface LlmExecutionContext {
  /** Feature label — widened to `string` so it matches the shared port contract. */
  feature: string;
  correlationId?: string;
  /** Optional caller signal — aborts the LLM call (and stops retries) immediately. */
  signal?: AbortSignal;
}
