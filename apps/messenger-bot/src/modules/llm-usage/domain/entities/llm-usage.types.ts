import type { ChatCompletion } from 'openai/resources/chat/completions';

export type LlmUsageFeature =
  | 'FREE_FORM_CHAT'
  | 'STUDENT_REPORT'
  | 'STUDY_REMINDER';

export type LlmUsageStatus = 'ok' | 'error';

/** Per-app adapter input: platform stores map their own shape to this. */
export interface RecordLlmUsageFromCompletionInput {
  feature: LlmUsageFeature;
  psid?: string;
  userId?: number;
  model: string;
  response: Pick<ChatCompletion, 'id' | 'usage'>;
  correlationId?: string;
  toolRound?: number;
}

export interface RecordLlmUsageInput {
  feature: LlmUsageFeature;
  psid?: string;
  userId?: number;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens?: number;
  openaiResponseId?: string;
  correlationId?: string;
  toolRound?: number;
  status?: LlmUsageStatus;
  errorMessage?: string;
  estimatedCostUsd?: string | null;
}
