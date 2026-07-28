export interface ChatHistoryMessage {
  role: 'user' | 'assistant' | 'tool_summary';
  content: string;
}

export type ChatHistoryStoreKind = 'memory' | 'redis';

export type ChatQueueStoreKind = 'memory' | 'redis';

export type WebhookDedupeStoreKind = 'memory' | 'redis';

export const CHAT_QUEUE_BUFFER_TTL_SECONDS = 86_400;

export const WEBHOOK_POSTBACK_DEDUPE_MS = 15_000;
