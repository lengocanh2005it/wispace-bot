export interface RecordGroundingWarningInput {
  psid: string;
  userId?: number;
  correlationId?: string;
  reason: string;
  userTextPreview?: string;
  assistantTextPreview?: string;
  toolNamesUsed: string[];
}
