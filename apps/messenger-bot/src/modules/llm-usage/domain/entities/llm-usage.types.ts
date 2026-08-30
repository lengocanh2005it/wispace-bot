import type { LlmUsage } from '@wispace/llm-agent';

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
  provider?: string;
  model: string;
  response: { id: string; usage?: LlmUsage | null };
  correlationId?: string;
  toolRound?: number;
}

export interface RecordLlmUsageInput {
  feature: LlmUsageFeature;
  psid?: string;
  userId?: number;
  provider?: string;
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
