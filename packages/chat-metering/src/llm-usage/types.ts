export type LlmUsageStatus = 'ok' | 'error';

export interface RecordLlmUsageInput {
  feature: string;
  externalUserId?: string;
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

export interface LlmUsageAggregateRow {
  feature: string;
  model: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  storedCostUsd: string | null;
  unstoredPromptTokens: number;
  unstoredCompletionTokens: number;
  unstoredCachedTokens: number;
}

export interface LlmUsageQueryFilter {
  externalUserId?: string;
  userId?: number;
  fromDate: string;
  toDate: string;
}

export interface UsageWriterPort {
  write(event: RecordLlmUsageInput & { usageDate: string }): void;
}
