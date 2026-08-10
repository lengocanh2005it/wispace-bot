import { Injectable } from '@nestjs/common';
import { WEBHOOK_POSTBACK_DEDUPE_MS } from '../../domain/entities/messenger-store.types';
import type { WebhookDedupeStorePort } from '../../domain/repositories/webhook-dedupe.store.port';
import { MessengerChatSharedConfigService } from '../../application/services/messenger-chat-shared-config.service';

@Injectable()
export class MemoryWebhookDedupeStore implements WebhookDedupeStorePort {
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
    return Promise.resolve(false);
  }

  async forgetMessageMid(mid: string, _psid: string): Promise<void> {
    this.messageMids.delete(mid);
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
