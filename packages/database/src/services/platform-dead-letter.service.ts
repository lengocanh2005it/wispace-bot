import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  WebhookDeadLetterEntity,
  type WebhookDeadLetterEntry,
} from '../entities/webhook-dead-letter.entity';

/**
 * Dead letter queue for failed webhook events — shared by Discord and Zalo
 * (replaces their near-identical per-app services). Platform
 * (`'discord'` / `'zalo'`) parameterizes the saved row and queries.
 */
@Injectable()
export class PlatformDeadLetterService {
  private readonly logger = new Logger(PlatformDeadLetterService.name);

  constructor(
    private readonly platform: string,
    @InjectRepository(WebhookDeadLetterEntity)
    private readonly repo: Repository<WebhookDeadLetterEntity>,
  ) {}

  async save(input: {
    externalUserId: string;
    rawPayload: unknown;
    errorMessage: string;
  }): Promise<void> {
    try {
      await this.repo.save({
        platform: this.platform,
        externalUserId: input.externalUserId,

        rawPayload: input.rawPayload as object,
        errorMessage: input.errorMessage,
        status: 'pending',
      });
    } catch (error) {
      this.logger.warn(
        `Failed to save dead letter: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
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

  async markAbandoned(id: number, reason: string): Promise<void> {
    await this.repo.update(id, {
      status: 'abandoned',
      errorMessage: reason,
    });
  }

  async incrementRetry(id: number, errorMessage: string): Promise<void> {
    await this.repo
      .createQueryBuilder()
      .update(WebhookDeadLetterEntity)
      .set({
        retryCount: () => 'retry_count + 1',
        errorMessage,
      })
      .where('id = :id', { id })
      .execute();
  }
}
