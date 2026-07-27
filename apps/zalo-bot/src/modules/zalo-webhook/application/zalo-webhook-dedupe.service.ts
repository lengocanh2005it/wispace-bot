import { Injectable, Logger } from '@nestjs/common';

const DEFAULT_TTL_MS = 60_000;
const CLEANUP_INTERVAL_MS = 5_000;

/**
 * Simple in-memory webhook deduplication for Zalo.
 * Tracks recently processed message IDs to prevent duplicate processing
 * when Zalo retries webhooks.
 */
@Injectable()
export class ZaloWebhookDedupeService {
  private readonly logger = new Logger(ZaloWebhookDedupeService.name);
  private readonly seen = new Map<string, number>();
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly ttlMs: number = DEFAULT_TTL_MS) {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  /**
   * Returns true if this message was already recently processed.
   * Call this with message.msg_id to deduplicate text messages.
   */
  isDuplicate(msgId: string): boolean {
    const now = Date.now();
    const expiry = this.seen.get(msgId);
    if (expiry !== undefined && expiry > now) {
      return true;
    }
    this.seen.set(msgId, now + this.ttlMs);
    return false;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, expiry] of this.seen) {
      if (expiry <= now) {
        this.seen.delete(key);
      }
    }
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
  }
}
