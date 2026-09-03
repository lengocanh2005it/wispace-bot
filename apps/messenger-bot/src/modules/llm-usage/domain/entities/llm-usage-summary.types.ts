import type { LlmUsageAggregateRow } from '@wispace/chat-metering';

export type { LlmUsageAggregateRow };

export interface LlmUsageQueryFilter {
  psid?: string;
  userId?: number;
  fromDate: string;
  toDate: string;
}

export interface LlmUsageFeatureSummary {
  feature: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  /**
   * #553 — share of prompt tokens served from cache
   * (`cachedTokens / promptTokens`); null when there were no prompt tokens.
   */
  cacheHitRate: number | null;
  estimatedCostUsd: string | null;
}

export interface LlmUsageUserSummary {
  psid: string | null;
  userId: number | null;
  from: string;
  to: string;
  timezone: string;
  byFeature: LlmUsageFeatureSummary[];
  totals: Omit<LlmUsageFeatureSummary, 'feature'>;
  disclaimer: string;
}

export interface LlmUsageFleetSummary {
  date: string;
  timezone: string;
  byFeature: LlmUsageFeatureSummary[];
  totals: Omit<LlmUsageFeatureSummary, 'feature'>;
  disclaimer: string;
}
