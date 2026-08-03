import type { ChatCompletion } from 'openai/resources/chat/completions';

/** Per-app adapter input: Zalo maps this to the shared core's shape. */
export interface RecordLlmUsageFromCompletionInput {
  feature: string;
  zaloUserId: string;
  userId?: number;
  model: string;
  response: Pick<ChatCompletion, 'id' | 'usage'>;
  correlationId?: string;
  toolRound?: number;
}
