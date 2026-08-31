export interface InsertLlmSafetyEvent {
  feature: string;
  eventType: string;
  reason?: string;
  externalUserId?: string;
  userId?: number;
  correlationId?: string;
  payload?: Record<string, unknown>;
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
