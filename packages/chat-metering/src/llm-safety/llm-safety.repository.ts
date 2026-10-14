import type { Repository } from 'typeorm';
import { extractQueryRows } from '@wispace/bot-common/utils';
import type { LlmSafetyEventEntity } from '../entities/llm-safety-event.entity';
import type {
  InsertLlmSafetyEvent,
  LlmSafetyEventRepositoryPort,
} from './types';

export class LlmSafetyEventRepository implements LlmSafetyEventRepositoryPort {
  constructor(
    private readonly repo: Repository<LlmSafetyEventEntity>,
    private readonly platform: string,
  ) {}

  async insert(event: InsertLlmSafetyEvent): Promise<void> {
    const entity = this.repo.create({
      feature: event.feature,
      eventType: event.eventType,
      reason: event.reason ?? null,
      platform: this.platform,
      externalUserId: event.externalUserId ?? null,
      userId: event.userId ?? null,
      correlationId: event.correlationId ?? null,
      payload: event.payload ?? null,
    });
    await this.repo.save(entity);
  }

  async countSince(since: Date): Promise<number> {
    return this.repo
      .createQueryBuilder('e')
      .where('e.platform = :platform', { platform: this.platform })
      .andWhere('e.createdAt >= :since', { since })
      .getCount();
  }

  async deleteOlderThan(before: Date): Promise<number> {
    const BATCH_SIZE = 1000;
    let totalDeleted = 0;

    for (;;) {
      const deleted = extractQueryRows<{ id: string }>(
        await this.repo.manager.query(
          `
            DELETE FROM llm_safety_events
            WHERE id IN (
              SELECT id FROM llm_safety_events
              WHERE platform = $1 AND created_at < $2
              LIMIT $3
            )
            RETURNING id
          `,
          [this.platform, before, BATCH_SIZE],
        ),
      );

      totalDeleted += deleted.length;

      if (deleted.length < BATCH_SIZE) {
        break;
      }
    }

    return totalDeleted;
  }
}
