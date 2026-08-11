import { Injectable } from '@nestjs/common';
import { WEBHOOK_POSTBACK_DEDUPE_MS } from '../../domain/entities/messenger-store.types';
import type { WebhookDedupeStorePort } from '../../domain/repositories/webhook-dedupe.store.port';
import { MessengerChatSharedConfigService } from '../../application/services/messenger-chat-shared-config.service';

@Injectable()
export class MemoryWebhookDedupeStore implements WebhookDedupeStorePort {
  /** Bounded LRU-ish cap — a mid flood must not grow memory unboundedly. */
  private static readonly MAX_MESSAGE_MIDS = 10_000;
  private static readonly MAX_POSTBACKS = 1_000;

  private readonly messageMids = new Map<string, number>();
  private readonly postbacks = new Map<string, number>();

  constructor(
    private readonly sharedConfig: MessengerChatSharedConfigService,
  ) {}

  isDuplicateMessageMid(mid: string, psid: string): Promise<boolean> {
    void psid;
    this.evictStaleMessageMids();

    const now = Date.now();
    const lastSeen = this.messageMids.get(mid);
    const retentionMs = this.sharedConfig.getWebhookDedupeRetentionMs();

    if (lastSeen !== undefined && now - lastSeen < retentionMs) {
      return Promise.resolve(true);
    }

    this.messageMids.set(mid, now);
    this.evictOverflow(
      this.messageMids,
      MemoryWebhookDedupeStore.MAX_MESSAGE_MIDS,
    );
    return Promise.resolve(false);
  }

  isDuplicatePostback(psid: string, payload: string): Promise<boolean> {
    this.evictStalePostbacks();

    const key = `${psid}:${payload}`;
    const now = Date.now();
    const lastSeen = this.postbacks.get(key);

    if (lastSeen !== undefined && now - lastSeen < WEBHOOK_POSTBACK_DEDUPE_MS) {
      return Promise.resolve(true);
    }

    this.postbacks.set(key, now);
    this.evictOverflow(this.postbacks, MemoryWebhookDedupeStore.MAX_POSTBACKS);
    return Promise.resolve(false);
  }

  forgetMessageMid(mid: string, _psid: string): Promise<void> {
    void _psid;
    this.messageMids.delete(mid);
    return Promise.resolve();
  }

  /** Drops the oldest entries once the map exceeds the cap (Map preserves insertion order). */
  private evictOverflow(map: Map<string, number>, max: number): void {
    while (map.size > max) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) {
        return;
      }
      map.delete(oldest);
    }
  }

  private evictStaleMessageMids(): void {
    const retentionMs = this.sharedConfig.getWebhookDedupeRetentionMs();
    const now = Date.now();

    for (const [mid, seenAt] of this.messageMids) {
      if (now - seenAt >= retentionMs) {
        this.messageMids.delete(mid);
      }
    }
  }

  private evictStalePostbacks(): void {
    const now = Date.now();

    for (const [key, seenAt] of this.postbacks) {
      if (now - seenAt >= WEBHOOK_POSTBACK_DEDUPE_MS) {
        this.postbacks.delete(key);
      }
    }
  }
}
