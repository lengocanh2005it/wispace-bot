import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { ChatQuotaEventEntity } from '@messenger/infrastructure/database/entities/chat-quota-event.entity';
import type {
  ChatQuotaEventRepositoryPort,
  InsertChatQuotaDeniedInput,
  InsertChatQuotaReleasedInput,
  InsertChatQuotaReservedInput,
} from '../../domain/repositories/chat-quota-event.repository.port';

const PLATFORM = 'messenger' as const;

@Injectable()
export class ChatQuotaEventRepository implements ChatQuotaEventRepositoryPort {
  constructor(
    @InjectRepository(ChatQuotaEventEntity)
    private readonly eventRepo: Repository<ChatQuotaEventEntity>,
  ) {}

  async insertReservedInTransaction(
    manager: EntityManager,
    input: InsertChatQuotaReservedInput,
  ): Promise<void> {
    await manager.query(
      `
        INSERT INTO chat_quota_events (
          platform,
          aggregate_id,
          aggregate_type,
          event_type,
          payload,
          usage_date,
          user_id,
          idempotency_key
        )
        VALUES ($1, $2, 'chat_quota', 'CHAT_QUOTA_RESERVED', $3::jsonb, $4::date, $5, $6)
      `,
      [
        PLATFORM,
        input.psid,
        JSON.stringify(input.payload),
        input.usageDate,
        input.userId ?? null,
        input.idempotencyKey,
      ],
    );
  }

  async insertReleasedInTransaction(
    manager: EntityManager,
    input: InsertChatQuotaReleasedInput,
  ): Promise<void> {
    await manager.query(
      `
        INSERT INTO chat_quota_events (
          platform,
          aggregate_id,
          aggregate_type,
          event_type,
          payload,
          usage_date,
          user_id,
          idempotency_key
        )
        VALUES ($1, $2, 'chat_quota', 'CHAT_QUOTA_RELEASED', $3::jsonb, $4::date, $5, $6)
      `,
      [
        PLATFORM,
        input.psid,
        JSON.stringify(input.payload),
        input.usageDate,
        input.userId ?? null,
        input.idempotencyKey,
      ],
    );
  }

  async insertDenied(input: InsertChatQuotaDeniedInput): Promise<void> {
    await this.eventRepo.manager.query(
      `
        INSERT INTO chat_quota_events (
          platform,
          aggregate_id,
          aggregate_type,
          event_type,
          payload,
          usage_date,
          user_id,
          idempotency_key
        )
        VALUES ($1, $2, 'chat_quota', 'CHAT_QUOTA_DENIED', $3::jsonb, $4::date, $5, NULL)
      `,
      [
        PLATFORM,
        input.psid,
        JSON.stringify(input.payload),
        input.usageDate,
        input.userId ?? null,
      ],
    );
  }

  async deleteOlderThan(cutoff: Date): Promise<number> {
    const rows: Array<{ count: string }> = await this.eventRepo.manager.query(
      `
        WITH deleted AS (
          DELETE FROM chat_quota_events
          WHERE occurred_at < $1
          RETURNING id
        )
        SELECT COUNT(*)::text AS count FROM deleted
      `,
      [cutoff],
    );

    return Number(rows[0]?.count ?? 0);
  }
}
