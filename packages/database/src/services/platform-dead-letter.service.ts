import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  errorMessage,
  maskExternalIdInText,
} from '@wispace/bot-common/masking';
import { sleep } from '@wispace/bot-common/utils';
import {
  WebhookDeadLetterEntity,
  type WebhookDeadLetterEntry,
} from '../entities/webhook-dead-letter.entity';
import type { OutboundDeliveryOutcome, Platform } from '../types';

/** Result of an atomic dead-letter claim — the caller owns the row until it
 * marks/abandons with the lease token. */
export interface DeadLetterClaim {
  id: number;
  leaseToken: string;
  deliveryKey: string;
}

/**
 * Dead letter queue for failed webhook events — shared by Discord and Zalo
 * (replaces their near-identical per-app services). Platform
 * (`'discord'` / `'zalo'`) parameterizes the saved row and queries.
 *
 * Crash safety (#291): rows are claimed with an owner lease before the
 * provider is called, the stable `delivery_key` is persisted in the same
 * claim (so retries reuse it and the provider can deduplicate), and every
 * terminal write requires the lease token — a stale worker can never
 * overwrite a recovered row.
 */
@Injectable()
export class PlatformDeadLetterService {
  private static readonly SAVE_RETRY_DELAYS_MS = [0, 50, 100];
  private readonly logger = new Logger(PlatformDeadLetterService.name);

  constructor(
    private readonly platform: Platform,
    @InjectRepository(WebhookDeadLetterEntity)
    private readonly repo: Repository<WebhookDeadLetterEntity>,
  ) {}

  /**
   * Persists a dead-letter entry with bounded retries.
   * @returns `true` when a durable record exists, `false` when persistence
   * failed after all attempts — callers must NOT treat the failure as
   * handled in that case (no recovery record means the message is lost).
   */
  async save(input: {
    externalUserId: string;
    rawPayload: unknown;
    errorMessage: string;
    /** Outbound sends are retried by the shared cron; inbound events are not. */
    direction?: 'inbound' | 'outbound';
  }): Promise<boolean> {
    let lastError: unknown;
    for (const delayMs of PlatformDeadLetterService.SAVE_RETRY_DELAYS_MS) {
      if (delayMs > 0) {
        await sleep(delayMs);
      }
      try {
        await this.repo.save({
          platform: this.platform,
          externalUserId: input.externalUserId,
          direction: input.direction ?? 'inbound',
          rawPayload: input.rawPayload as object,
          errorMessage: maskExternalIdInText(
            input.errorMessage,
            input.externalUserId,
          ),
          status: 'pending',
        });
        return true;
      } catch (error) {
        lastError = error;
      }
    }

    // Explicit failure signal: the failed outbound send has NO durable
    // recovery record — surfaced as an error so operators can alert.
    this.logger.error(
      `Failed to persist dead letter for ${this.platform}UserId=${maskExternalIdInText(
        input.externalUserId,
        input.externalUserId,
      )} after ${PlatformDeadLetterService.SAVE_RETRY_DELAYS_MS.length} attempts — no durable recovery record: ${errorMessage(
        lastError,
      )}`,
    );
    return false;
  }

  async listPendingForRetry(opts: {
    limit: number;
    olderThan: Date;
    maxRetries: number;
  }): Promise<WebhookDeadLetterEntry[]> {
    return this.repo
      .createQueryBuilder('dl')
      .where('dl.platform = :platform', { platform: this.platform })
      .andWhere('dl.status = :status', { status: 'pending' })
      .andWhere('dl.direction = :direction', { direction: 'outbound' })
      .andWhere('dl.retry_count < :maxRetries', {
        maxRetries: opts.maxRetries,
      })
      .andWhere('dl.updated_at < :olderThan', { olderThan: opts.olderThan })
      .orderBy('dl.created_at', 'ASC')
      .limit(opts.limit)
      .getMany();
  }

  /**
   * Atomically claims a pending row for replay: moves it to `processing`,
   * assigns an owner lease, and persists a stable `delivery_key` (kept from a
   * previous attempt so the provider can deduplicate, e.g. Discord's nonce).
   * Only one worker can claim — a concurrent claim returns `null`.
   */
  async claimForRetry(
    id: number,
    leaseMs: number,
  ): Promise<DeadLetterClaim | null> {
    const rows: Array<{
      id: number;
      lease_token: string;
      delivery_key: string;
    }> = await this.repo.manager.query(
      `
      UPDATE "webhook_dead_letters"
      SET status = 'processing',
          lease_token = gen_random_uuid(),
          lease_expires_at = now() + ($2::int * interval '1 millisecond'),
          processing_started_at = now(),
          delivery_key = COALESCE(delivery_key, gen_random_uuid()::text),
          updated_at = now()
      WHERE id = $1 AND status = 'pending' AND direction = 'outbound'
      RETURNING id, lease_token, delivery_key
    `,
      [id, leaseMs],
    );

    return rows.length > 0
      ? {
          id: rows[0].id,
          leaseToken: rows[0].lease_token,
          deliveryKey: rows[0].delivery_key,
        }
      : null;
  }

  /**
   * Marks a claimed row as successfully replayed. With a lease token, only the
   * current owner can mark — a stale worker after lease recovery no-ops.
   */
  async markReplayed(
    id: number,
    leaseToken?: string,
    deliveryKey?: string,
  ): Promise<boolean> {
    if (leaseToken !== undefined) {
      const result = await this.repo
        .createQueryBuilder()
        .update(WebhookDeadLetterEntity)
        .set({
          status: 'replayed',
          replayedAt: new Date(),
          deliveryStatus: 'sent',
          ...(deliveryKey !== undefined ? { deliveryKey } : {}),
        })
        .where('id = :id', { id })
        .andWhere('status = :status', { status: 'processing' })
        .andWhere('lease_token = :leaseToken', { leaseToken })
        .execute();
      return (result.affected ?? 0) > 0;
    }

    await this.repo.update(id, {
      status: 'replayed',
      replayedAt: new Date(),
      deliveryStatus: 'sent',
    });
    return true;
  }

  async markAbandoned(
    id: number,
    reason: string,
    externalUserId?: string,
    opts?: {
      leaseToken?: string;
      deliveryStatus?: OutboundDeliveryOutcome;
    },
  ): Promise<boolean> {
    const patch: Partial<WebhookDeadLetterEntity> = {
      status: 'abandoned',
      errorMessage: maskExternalIdInText(reason, externalUserId),
    };
    if (opts?.deliveryStatus !== undefined) {
      patch.deliveryStatus = opts.deliveryStatus;
    }

    if (opts?.leaseToken !== undefined) {
      const result = await this.repo
        .createQueryBuilder()
        .update(WebhookDeadLetterEntity)
        .set(patch)
        .where('id = :id', { id })
        .andWhere('status = :status', { status: 'processing' })
        .andWhere('lease_token = :leaseToken', { leaseToken: opts.leaseToken })
        .execute();
      return (result.affected ?? 0) > 0;
    }

    await this.repo.update(id, patch);
    return true;
  }

  /**
   * Records a failed attempt and re-opens the row for the next tick. With a
   * lease token, requires the current owner; `updated_at` is refreshed so the
   * min-retry-age window applies per attempt.
   */
  async incrementRetry(
    id: number,
    errorMessage: string,
    externalUserId?: string,
    opts?: { leaseToken?: string },
  ): Promise<boolean> {
    const set: Record<string, unknown> = {
      retryCount: () => 'retry_count + 1',
      errorMessage: maskExternalIdInText(errorMessage, externalUserId),
      status: 'pending',
      leaseToken: null,
      leaseExpiresAt: null,
      processingStartedAt: null,
      updatedAt: new Date(),
    };

    let qb = this.repo
      .createQueryBuilder()
      .update(WebhookDeadLetterEntity)
      .set(set)
      .where('id = :id', { id });

    if (opts?.leaseToken !== undefined) {
      qb = qb
        .andWhere('status = :status', { status: 'processing' })
        .andWhere('lease_token = :leaseToken', {
          leaseToken: opts.leaseToken,
        });
    }

    const result = await qb.execute();
    return (result.affected ?? 0) > 0;
  }
}
