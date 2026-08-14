import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { errorMessage, maskExternalIdInText, sleep } from '@wispace/bot-common';
import {
  WebhookDeadLetterEntity,
  type WebhookDeadLetterEntry,
} from '../entities/webhook-dead-letter.entity';
import type { Platform } from '../types';

/**
 * Dead letter queue for failed webhook events — shared by Discord and Zalo
 * (replaces their near-identical per-app services). Platform
 * (`'discord'` / `'zalo'`) parameterizes the saved row and queries.
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

  async markReplayed(id: number): Promise<void> {
    await this.repo.update(id, {
      status: 'replayed',
      replayedAt: new Date(),
    });
  }

  async markAbandoned(
    id: number,
    reason: string,
    externalUserId?: string,
  ): Promise<void> {
    await this.repo.update(id, {
      status: 'abandoned',
      errorMessage: maskExternalIdInText(reason, externalUserId),
    });
  }

  async incrementRetry(
    id: number,
    errorMessage: string,
    externalUserId?: string,
  ): Promise<void> {
    await this.repo
      .createQueryBuilder()
      .update(WebhookDeadLetterEntity)
      .set({
        retryCount: () => 'retry_count + 1',
        errorMessage: maskExternalIdInText(errorMessage, externalUserId),
      })
      .where('id = :id', { id })
      .execute();
  }
}
