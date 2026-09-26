import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { subMilliseconds } from 'date-fns';
import {
  errorMessage,
  maskExternalIdInText,
} from '@wispace/bot-common/masking';
import {
  runLockedTick,
  type CronHeartbeatMetricsPort,
  type LockedTickItem,
} from '@wispace/bot-common/cron';
import { PgAdvisoryLockService } from '@wispace/bot-common/locks';
import { readEnvPositiveInt } from '@wispace/bot-common/config';
import type { OutboundDeliveryOutcome } from '@wispace/contracts';
import type { WebhookDeadLetterEntry } from '../../entities/webhook-dead-letter.entity';
import { PlatformDeadLetterService } from './platform-dead-letter.service';

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MIN_RETRY_AGE_MS = 60_000;
const DEFAULT_RETRY_LIMIT = 10;
const DEFAULT_LEASE_MS = 600_000;
const DEFAULT_CRON_NAME = 'platform-dead-letter-retry';

type DeadLetterItemDetail =
  | 'replayed'
  | 'abandoned'
  | 'retried'
  | 'claim_skipped'
  | 'failed';

interface DeadLetterRetrySettings {
  maxRetries: number;
  minRetryAgeMs: number;
  retryLimit: number;
  leaseMs: number;
}

/**
 * The dead-letter replay evaluates eligibility every 5 minutes. The actual
 * replay drip is gated by WEBHOOK_DEAD_LETTER_MIN_RETRY_AGE_MS, so tick
 * frequency only bounds detection latency. Keep this expression and the
 * registerCron expected interval in agreement — a mismatch makes
 * CronExecutionStale fire a permanent false positive (#862): the previous
 * expression fired every 5 HOURS while the registered expectation was
 * 5 minutes.
 */
export const DEAD_LETTER_RETRY_CRON = '*/5 * * * *';
export const DEAD_LETTER_RETRY_EXPECTED_INTERVAL_MS = 5 * 60 * 1000;

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
  /** Optional per-bot heartbeat metrics. */
  metrics?: CronHeartbeatMetricsPort;
  /** Metric cron name; defaults to the shared dead-letter name. */
  cronName?: string;
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
  ) {
    this.options.metrics?.registerCron(
      this.options.cronName ?? DEFAULT_CRON_NAME,
      DEAD_LETTER_RETRY_EXPECTED_INTERVAL_MS,
    );
  }

  @Cron(DEAD_LETTER_RETRY_CRON, { timeZone: 'Asia/Ho_Chi_Minh' })
  async handleRetry(): Promise<void> {
    let settings: DeadLetterRetrySettings | undefined;
    await runLockedTick<DeadLetterItemDetail, WebhookDeadLetterEntry>({
      name: this.options.cronName ?? DEFAULT_CRON_NAME,
      withLock: (run) => this.pgLock.withLock(this.options.lockId, run),
      fetchBatch: async () => {
        settings = this.readRetrySettings();
        const entries = await this.deadLetterService.listPendingForRetry({
          limit: settings.retryLimit,
          olderThan: subMilliseconds(new Date(), settings.minRetryAgeMs),
          maxRetries: settings.maxRetries,
        });
        if (entries.length > 0) {
          this.logger.log(`Retrying ${entries.length} dead letter entries`);
        }
        return entries;
      },
      processItem: (entry) => this.retryEntry(entry, settings!),
      metrics: this.options.metrics,
      logger: this.logger,
    });
  }

  private readRetrySettings(): DeadLetterRetrySettings {
    return {
      maxRetries: this.readPositiveInt(
        'WEBHOOK_DEAD_LETTER_MAX_RETRIES',
        DEFAULT_MAX_RETRIES,
      ),
      minRetryAgeMs: this.readPositiveInt(
        'WEBHOOK_DEAD_LETTER_MIN_RETRY_AGE_MS',
        DEFAULT_MIN_RETRY_AGE_MS,
      ),
      retryLimit: this.readPositiveInt(
        'WEBHOOK_DEAD_LETTER_RETRY_LIMIT',
        DEFAULT_RETRY_LIMIT,
      ),
      leaseMs: this.readPositiveInt(
        'WEBHOOK_DEAD_LETTER_LEASE_MS',
        DEFAULT_LEASE_MS,
      ),
    };
  }

  private async retryEntry(
    entry: WebhookDeadLetterEntry,
    settings: DeadLetterRetrySettings,
  ): Promise<LockedTickItem<DeadLetterItemDetail>> {
    let item: LockedTickItem<DeadLetterItemDetail> = {
      outcome: 'skipped',
      details: 'claim_skipped',
    };
    let leaseToken: string | undefined;

    try {
      const claimed = await this.deadLetterService.claimForRetry(
        entry.id,
        settings.leaseMs,
      );
      if (!claimed) return item;
      leaseToken = claimed.leaseToken;

      const payload = entry.rawPayload as Record<string, unknown>;
      const { externalUserId, text } = this.options.extractPayload(payload);
      if (!externalUserId || !text) {
        await this.deadLetterService.markAbandoned(
          entry.id,
          this.options.abandonReason,
          entry.externalUserId ?? undefined,
          { leaseToken: claimed.leaseToken },
        );
        return { outcome: 'succeeded', details: 'abandoned' };
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
        return { outcome: 'succeeded', details: 'replayed' };
      }
      if (outcome === 'ambiguous' && this.options.retryAmbiguous) {
        await this.deadLetterService.incrementRetry(
          entry.id,
          'ambiguous delivery — retried with the same delivery key',
          entry.externalUserId ?? undefined,
          { leaseToken: claimed.leaseToken },
        );
        return { outcome: 'succeeded', details: 'retried' };
      }
      if (outcome === 'ambiguous') {
        await this.deadLetterService.markAbandoned(
          entry.id,
          'ambiguous delivery — not auto-retried',
          entry.externalUserId ?? undefined,
          { leaseToken: claimed.leaseToken, deliveryStatus: 'ambiguous' },
        );
        return { outcome: 'succeeded', details: 'abandoned' };
      }
      if (outcome === 'rate_limited') {
        await this.deadLetterService.markAbandoned(
          entry.id,
          'outbound_rate_limited',
          entry.externalUserId ?? undefined,
          { leaseToken: claimed.leaseToken, deliveryStatus: 'rate_limited' },
        );
        return { outcome: 'succeeded', details: 'abandoned' };
      }

      await this.handleFailure(
        entry,
        'send failed',
        claimed.leaseToken,
        settings.maxRetries,
      );
      return {
        outcome: 'succeeded',
        details:
          (entry.retryCount ?? 0) + 1 >= settings.maxRetries
            ? 'abandoned'
            : 'retried',
      };
    } catch (error) {
      const errorMsg = maskExternalIdInText(
        errorMessage(error),
        entry.externalUserId,
      );
      if (leaseToken) {
        try {
          await this.handleFailure(
            entry,
            errorMsg,
            leaseToken,
            settings.maxRetries,
          );
          item = {
            outcome: 'succeeded',
            details:
              (entry.retryCount ?? 0) + 1 >= settings.maxRetries
                ? 'abandoned'
                : 'retried',
          };
        } catch (transitionError) {
          this.logger.error(
            `Dead-letter retry state transition failed id=${entry.id}: ${maskExternalIdInText(errorMessage(transitionError), entry.externalUserId)}`,
          );
        }
      }
      this.logger.error(
        `Dead-letter retry item failed id=${entry.id}: ${errorMsg}`,
      );
      return item.outcome === 'skipped'
        ? { outcome: 'failed', details: 'failed' }
        : item;
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
    return readEnvPositiveInt(this.configService, key, fallback);
  }
}
