import type { Repository } from 'typeorm';
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
    const result = await this.repo
      .createQueryBuilder()
      .delete()
      .where('"platform" = :platform', { platform: this.platform })
      .andWhere('"created_at" < :before', { before })
      .execute();

    return result.affected ?? 0;
  }
}
