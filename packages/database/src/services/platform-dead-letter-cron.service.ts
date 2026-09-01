import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { subMilliseconds } from 'date-fns';
import {
  errorMessage,
  maskExternalIdInText,
} from '@wispace/bot-common/masking';
import { PgAdvisoryLockService } from '@wispace/bot-common/locks';
import type { OutboundDeliveryOutcome } from '@wispace/contracts';
import { PlatformDeadLetterService } from './platform-dead-letter.service';

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MIN_RETRY_AGE_MS = 60_000;
const DEFAULT_RETRY_LIMIT = 10;
const DEFAULT_LEASE_MS = 600_000;

export interface DeadLetterCronOptions {
  /** Advisory lock id — only one pod retries the dead letter per tick. */
  lockId: number;
  /** Extract the retry target (external user id + text) from a saved raw webhook payload. */
  extractPayload: (payload: Record<string, unknown>) => {
    externalUserId?: string;
    text?: string;
  };
  /** Mark-abandoned reason when the payload can't be extracted. */
  abandonReason: string;
  /**
   * Platform outbound send. Returns the delivery outcome; the caller reuses
   * the persisted `deliveryKey` so the provider can deduplicate (Discord's
   * stable nonce). May throw for unexpected errors — treated as `not_sent`.
   */
  sendText: (
    externalUserId: string,
    text: string,
    opts?: { deliveryKey?: string },
  ) => Promise<OutboundDeliveryOutcome>;
  /**
   * When true (Discord — stable nonce deduplicates), an `ambiguous` outcome is
   * retried with the same delivery key. When false (Messenger/Zalo), an
   * `ambiguous` outcome is terminal — the provider may have accepted the
   * message, so auto-resend would risk a duplicate (#291).
   */
  retryAmbiguous?: boolean;
}

/**
 * Retries failed platform outbound deliveries from the dead letter queue.
 * Only `outbound` entries are replayed — inbound webhook events are never
 * re-sent via `sendText` (that used to echo the user's own text back).
 * Runs every 5 minutes under an advisory lock (multi-pod safe).
 *
 * Crash safety (#291): every row is claimed with an owner lease before the
 * provider is called, the stable delivery key is persisted in the claim, and
 * all terminal writes require the lease token. A crash after provider ack but
 * before the DB update leaves the row `processing`; the stale lease is never
 * auto-replayed (the message may already be delivered) — it is surfaced for
 * operator review.
 */
@Injectable()
export class PlatformDeadLetterCronService {
  private readonly logger = new Logger(PlatformDeadLetterCronService.name);

  constructor(
    private readonly deadLetterService: PlatformDeadLetterService,
    private readonly configService: ConfigService,
    private readonly pgLock: PgAdvisoryLockService,
    private readonly options: DeadLetterCronOptions,
  ) {}

  @Cron('0 */5 * * *', { timeZone: 'Asia/Ho_Chi_Minh' })
  async handleRetry(): Promise<void> {
    const result = await this.pgLock.withLock(this.options.lockId, () =>
      this.runRetryBatch(),
    );

    if (result === null) {
      this.logger.debug(
        'webhook-dead-letter-retry skipped — lock held by another pod',
      );
    }
  }

  private async runRetryBatch(): Promise<void> {
    const maxRetries = this.readPositiveInt(
      'WEBHOOK_DEAD_LETTER_MAX_RETRIES',
      DEFAULT_MAX_RETRIES,
    );
    const minRetryAgeMs = this.readPositiveInt(
      'WEBHOOK_DEAD_LETTER_MIN_RETRY_AGE_MS',
      DEFAULT_MIN_RETRY_AGE_MS,
    );
    const retryLimit = this.readPositiveInt(
      'WEBHOOK_DEAD_LETTER_RETRY_LIMIT',
      DEFAULT_RETRY_LIMIT,
    );
    const leaseMs = this.readPositiveInt(
      'WEBHOOK_DEAD_LETTER_LEASE_MS',
      DEFAULT_LEASE_MS,
    );

    const olderThan = subMilliseconds(new Date(), minRetryAgeMs);
    const entries = await this.deadLetterService.listPendingForRetry({
      limit: retryLimit,
      olderThan,
      maxRetries,
    });

    if (entries.length === 0) return;

    this.logger.log(`Retrying ${entries.length} dead letter entries`);

    for (const entry of entries) {
      const claimed = await this.deadLetterService.claimForRetry(
        entry.id,
        leaseMs,
      );
      if (!claimed) continue; // another worker owns it, or the row changed

      try {
        const payload = entry.rawPayload as Record<string, unknown>;
        const { externalUserId, text } = this.options.extractPayload(payload);
        if (!externalUserId || !text) {
          await this.deadLetterService.markAbandoned(
            entry.id,
            this.options.abandonReason,
            entry.externalUserId ?? undefined,
            { leaseToken: claimed.leaseToken },
          );
          continue;
        }

        const outcome = await this.options.sendText(externalUserId, text, {
          deliveryKey: claimed.deliveryKey,
        });

        if (outcome === 'sent') {
          await this.deadLetterService.markReplayed(
            entry.id,
            claimed.leaseToken,
            claimed.deliveryKey,
          );
        } else if (outcome === 'ambiguous') {
          if (this.options.retryAmbiguous) {
            // Discord: stable nonce makes the retry safe — same delivery key.
            await this.deadLetterService.incrementRetry(
              entry.id,
              'ambiguous delivery — retried with the same delivery key',
              entry.externalUserId ?? undefined,
              { leaseToken: claimed.leaseToken },
            );
          } else {
            // Messenger/Zalo: provider may have accepted — no auto-resend.
            await this.deadLetterService.markAbandoned(
              entry.id,
              'ambiguous delivery — not auto-retried',
              entry.externalUserId ?? undefined,
              {
                leaseToken: claimed.leaseToken,
                deliveryStatus: 'ambiguous',
              },
            );
          }
        } else if (outcome === 'rate_limited') {
          // Rate limiting is a local containment decision. Retrying the same
          // row would immediately re-admit the storm and create noise.
          await this.deadLetterService.markAbandoned(
            entry.id,
            'outbound_rate_limited',
            entry.externalUserId ?? undefined,
            {
              leaseToken: claimed.leaseToken,
              deliveryStatus: 'rate_limited',
            },
          );
        } else {
          await this.handleFailure(
            entry,
            'send failed',
            claimed.leaseToken,
            maxRetries,
          );
        }
      } catch (error) {
        const errorMsg = maskExternalIdInText(
          errorMessage(error),
          entry.externalUserId,
        );
        await this.handleFailure(
          entry,
          errorMsg,
          claimed.leaseToken,
          maxRetries,
        );
      }
    }
  }

  private async handleFailure(
    entry: { id: number; retryCount: number; externalUserId: string | null },
    errorMsg: string,
    leaseToken: string,
    maxRetries: number,
  ): Promise<void> {
    if ((entry.retryCount ?? 0) + 1 >= maxRetries) {
      await this.deadLetterService.markAbandoned(
        entry.id,
        errorMsg,
        entry.externalUserId ?? undefined,
        { leaseToken },
      );
    } else {
      await this.deadLetterService.incrementRetry(
        entry.id,
        errorMsg,
        entry.externalUserId ?? undefined,
        { leaseToken },
      );
    }
  }

  private readPositiveInt(key: string, fallback: number): number {
    const raw = this.configService.get<string>(key);
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed > 0
      ? Math.floor(parsed)
      : fallback;
  }
}
