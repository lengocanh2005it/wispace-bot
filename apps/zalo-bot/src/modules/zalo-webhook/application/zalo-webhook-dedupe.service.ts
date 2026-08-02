import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { RedisWebhookDedupeStore } from '@wispace/bot-common';

const DEFAULT_TTL_MS = 60_000;
const CLEANUP_INTERVAL_MS = 5_000;

@Injectable()
export class ZaloWebhookDedupeService implements OnModuleDestroy {
  private readonly logger = new Logger(ZaloWebhookDedupeService.name);
  private readonly seen = new Map<string, number>();
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;
  private readonly useRedis: boolean;

  constructor(
    @Optional() private readonly redisStore?: RedisWebhookDedupeStore,
  ) {
    this.useRedis = this.redisStore?.isAvailable() ?? false;
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  async isDuplicate(msgId: string): Promise<boolean> {
    if (this.useRedis && this.redisStore) {
      return this.redisStore.isDuplicateMessageMid(msgId);
    }
    const now = Date.now();
    const expiry = this.seen.get(msgId);
    if (expiry !== undefined && expiry > now) {
      return true;
    }
    this.seen.set(msgId, now + DEFAULT_TTL_MS);
    return false;
  }

  private cleanup(): void {
    if (this.useRedis) return;
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
