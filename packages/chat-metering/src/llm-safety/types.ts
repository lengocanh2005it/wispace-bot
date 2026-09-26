import type { FlaggedClassifierLabel } from '@wispace/llm-agent/core';

export interface InsertLlmSafetyEvent {
  feature: string;
  eventType: string;
  reason?: string;
  externalUserId?: string;
  userId?: number;
  correlationId?: string;
  payload?: Record<string, unknown>;
}

/** Persistence port consumed by the framework-free safety core. */
export interface LlmSafetyEventRepositoryPort {
  insert(event: InsertLlmSafetyEvent): Promise<void>;
  countSince(since: Date): Promise<number>;
  deleteOlderThan(before: Date): Promise<number>;
}

export interface RecordGroundingWarningInput {
  externalUserId: string;
  userId?: number;
  correlationId?: string;
  reason: string;
  userTextPreview?: string;
  assistantTextPreview?: string;
  toolNamesUsed: string[];
}

/** Where a neutralized prompt-injection payload came from (#629). */
export type InjectionEventSource = 'user_input' | 'tool_result' | 'history';

export interface RecordInjectionEventInput {
  externalUserId: string;
  userId?: number;
  correlationId?: string;
  source: InjectionEventSource;
  reason: string;
  /** Offending pre-sanitization text — persisted only as a redacted excerpt + hash (#122). */
  textPreview?: string;
  toolName?: string;
}

export type HarmfulOutputReason =
  | 'self_harm_instruction'
  | 'targeted_harassment';

export interface RecordHarmfulOutputBlockedInput {
  externalUserId: string;
  userId?: number;
  correlationId?: string;
  reason: HarmfulOutputReason;
  /** Persisted only as a redacted excerpt + hash (#1377). */
  assistantTextPreview: string;
}

export interface RecordClassifierVerdictInput {
  externalUserId: string;
  userId?: number;
  correlationId?: string;
  /** Only non-SAFE verdicts are recorded. */
  label: FlaggedClassifierLabel;

  mode: 'shadow' | 'enforce';
  confidence: number;
  reason: string;
  /** Classifier input text — persisted only as a redacted excerpt + hash (#122). */
  textPreview: string;
}
