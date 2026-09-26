/**
 * The debounce queue seam for `ZaloChatService` (#1088). The queue itself is
 * an outer adapter (`PlatformChatQueueService` in `@wispace/chat-agent`); the
 * application service only needs to hand a message to it.
 */
export interface ZaloChatQueuePort {
  enqueue(
    zaloUserId: string,
    text: string,
    ctx: { userId?: number },
    idempotencyKey: string,
  ): Promise<void>;
}

export const ZALO_CHAT_QUEUE = Symbol('ZALO_CHAT_QUEUE');
