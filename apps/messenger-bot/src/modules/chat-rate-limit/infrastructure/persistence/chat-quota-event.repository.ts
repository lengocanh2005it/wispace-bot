import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Counter } from 'prom-client';
import { hashExternalId } from '@wispace/bot-common/masking';
import { extractQueryRows } from '@wispace/bot-common/utils';
import { ChatQuotaEventEntity } from '@messenger/infrastructure/database/entities/chat-quota-event.entity';
import type {
  ChatQuotaEventRepositoryPort,
  InsertChatQuotaDeniedInput,
  InsertChatQuotaReleasedInput,
  InsertChatQuotaReservedInput,
  TransactionManager,
} from '../../domain/repositories/chat-quota-event.repository.port';

const PLATFORM = 'messenger' as const;

function quotaAggregateId(psid: string, userId?: number): string {
  return hashExternalId(userId === undefined ? psid : String(userId));
}

const chatQuotaRetentionDeletedTotal = new Counter({
  name: 'chat_quota_retention_deleted_total',
  help: 'Total rows deleted by chat-quota retention cleanup',
});

@Injectable()
export class ChatQuotaEventRepository implements ChatQuotaEventRepositoryPort {
  constructor(
    @InjectRepository(ChatQuotaEventEntity)
    private readonly eventRepo: Repository<ChatQuotaEventEntity>,
  ) {}

  async insertReservedInTransaction(
    manager: TransactionManager,
    input: InsertChatQuotaReservedInput,
  ): Promise<void> {
    await (manager as EntityManager).query(
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
        quotaAggregateId(input.psid, input.userId),
        JSON.stringify(input.payload),
        input.usageDate,
        input.userId ?? null,
        input.idempotencyKey,
      ],
    );
  }

  async insertReleasedInTransaction(
    manager: TransactionManager,
    input: InsertChatQuotaReleasedInput,
  ): Promise<void> {
    await (manager as EntityManager).query(
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
        quotaAggregateId(input.psid, input.userId),
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
        quotaAggregateId(input.psid, input.userId),
        JSON.stringify(input.payload),
        input.usageDate,
        input.userId ?? null,
      ],
    );
  }

  async deleteOlderThan(cutoff: Date): Promise<number> {
    const BATCH_SIZE = 1000;
    let totalDeleted = 0;

    for (;;) {
      const deleted = extractQueryRows<{ id: string }>(
        await this.eventRepo.manager.query(
          `
            DELETE FROM chat_quota_events
            WHERE id IN (
              SELECT id FROM chat_quota_events
              WHERE occurred_at < $1
              LIMIT $2
            )
            RETURNING id
          `,
          [cutoff, BATCH_SIZE],
        ),
      );

      totalDeleted += deleted.length;

      if (deleted.length < BATCH_SIZE) {
        break;
      }
    }

    if (totalDeleted > 0) {
      chatQuotaRetentionDeletedTotal.inc(totalDeleted);
    }

    return totalDeleted;
  }
}
