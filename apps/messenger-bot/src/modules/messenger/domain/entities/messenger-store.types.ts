import type { ChatHistoryMessage } from '@wispace/chat-history';

export type { ChatHistoryMessage };

export type ChatHistoryStoreKind = 'memory' | 'redis';

export type ChatQueueStoreKind = 'memory' | 'redis';

export const CHAT_QUEUE_BUFFER_TTL_SECONDS = 86_400;
