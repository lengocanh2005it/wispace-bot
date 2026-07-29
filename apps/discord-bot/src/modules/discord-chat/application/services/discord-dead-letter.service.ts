import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WebhookDeadLetterEntity } from '@discord/infrastructure/database/entities/webhook-dead-letter.entity';

const PLATFORM = 'discord' as const;

export interface DeadLetterEntry {
  id: number;
  externalUserId: string | null;
  rawPayload: unknown;
  errorMessage: string;
  retryCount: number;
  status: string;
}

/**
 * Discord dead letter queue — saves failed webhook events for later retry.
 * Reuses the shared `webhook_dead_letters` table (platform='discord').
 */
@Injectable()
export class DiscordDeadLetterService {
  private readonly logger = new Logger(DiscordDeadLetterService.name);

  constructor(
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
        platform: PLATFORM,
        externalUserId: input.externalUserId,
        rawPayload: input.rawPayload,
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
  }): Promise<DeadLetterEntry[]> {
    return this.repo
      .createQueryBuilder('dl')
      .where('dl.platform = :platform', { platform: PLATFORM })
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
