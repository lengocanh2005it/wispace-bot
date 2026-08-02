import type { EntityManager, Repository } from 'typeorm';
import type { ChatDailyUsageEntity } from '../entities/chat-daily-usage.entity';
import type { ChatIdempotencyEntity } from '../entities/chat-idempotency.entity';
import type {
  ChatIdempotencyRecord,
  ChatIdempotencyStatus,
  RecoverIdempotencyOutcome,
  ReserveFreeFormSlotInput,
  ReserveFreeFormSlotOutcome,
  ReserveIdempotencyInput,
} from './types';

class DailyLimitExceededError extends Error {
  constructor() {
    super('Daily limit exceeded during reserve transaction');
    this.name = 'DailyLimitExceededError';
  }
}

class BurstLimitExceededError extends Error {
  constructor(readonly count: number) {
    super('Burst limit exceeded during reserve transaction');
    this.name = 'BurstLimitExceededError';
  }
}

/**
 * Optional hooks so a caller (e.g. messenger-bot's quota-event audit trail)
 * can persist extra telemetry inside the SAME DB transaction as the
 * reserve/refund — without this package knowing anything about that table.
 */
export interface ChatRateLimitRepositoryHooks {
  onReserved?(
    manager: EntityManager,
    params: {
      externalUserId: string;
      userId?: number;
      usageDate: string;
      idempotencyKey: string;
      limit: number;
      usedAfter: number;
    },
  ): Promise<void>;
  onReleased?(
    manager: EntityManager,
    params: {
      externalUserId: string;
      userId?: number;
      usageDate: string;
      idempotencyKey: string;
      reason: 'send_failed' | 'stuck_recover';
      usedAfter: number;
    },
  ): Promise<void>;
}

export class ChatRateLimitRepository {
  constructor(
    private readonly dailyUsageRepo: Repository<ChatDailyUsageEntity>,
    private readonly idempotencyRepo: Repository<ChatIdempotencyEntity>,
    private readonly platform: string,
    private readonly hooks: ChatRateLimitRepositoryHooks = {},
  ) {}

  async getDailyUsageCount(
    externalUserId: string,
    usageDate: string,
  ): Promise<number> {
    const row = await this.dailyUsageRepo.findOne({
      where: { platform: this.platform, externalUserId, usageDate },
      select: { freeFormCount: true },
    });

    return row?.freeFormCount ?? 0;
  }

  async tryReserveIdempotency(
    input: ReserveIdempotencyInput,
    manager: EntityManager = this.idempotencyRepo.manager,
  ): Promise<ChatIdempotencyRecord | null> {
    const rows: Array<{
      idempotency_key: string;
      external_user_id: string;
      user_id: number | null;
      usage_date: string;
      status: ChatIdempotencyStatus;
      reserved_at: Date;
    }> = await manager.query(
      `
        INSERT INTO chat_idempotency (
          idempotency_key,
          platform,
          external_user_id,
          user_id,
          usage_date,
          status
        )
        VALUES ($1, $2, $3, $4, $5::date, 'reserved')
        ON CONFLICT (platform, idempotency_key) DO NOTHING
        RETURNING
          idempotency_key,
          external_user_id,
          user_id,
          usage_date,
          status,
          reserved_at
      `,
      [
        input.idempotencyKey,
        this.platform,
        input.externalUserId,
        input.userId ?? null,
        input.usageDate,
      ],
    );

    const row = rows[0];
    if (!row) {
      return null;
    }

    return this.mapIdempotency(row);
  }

  async reserveFreeFormSlotInTransaction(
    input: ReserveFreeFormSlotInput,
  ): Promise<ReserveFreeFormSlotOutcome> {
    try {
      return await this.dailyUsageRepo.manager.transaction(async (manager) => {
        if (input.burstLimit !== undefined && input.burstSince) {
          await manager.query(
            'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
            [`${this.platform}:${input.externalUserId}`],
          );
        }

        const idempotency = await this.tryReserveIdempotency(input, manager);
        if (!idempotency) {
          return { status: 'idempotency_conflict' };
        }

        if (input.burstLimit !== undefined && input.burstSince) {
          const burstRows: Array<{ count: string }> = await manager.query(
            `
              SELECT COUNT(*)::text AS count
              FROM chat_idempotency
              WHERE platform = $1 AND external_user_id = $2
                AND reserved_at > $3
                AND status IN ('reserved', 'completed')
            `,
            [this.platform, input.externalUserId, input.burstSince],
          );
          const count = Number(burstRows[0]?.count ?? 0);
          if (count > input.burstLimit) {
            throw new BurstLimitExceededError(count);
          }
        }

        const rows: Array<{ free_form_count: number }> = await manager.query(
          `
            INSERT INTO chat_daily_usage (platform, external_user_id, user_id, usage_date, free_form_count)
            VALUES ($1, $2, $3, $4::date, 1)
            ON CONFLICT (platform, external_user_id, usage_date)
            DO UPDATE SET
              free_form_count = chat_daily_usage.free_form_count + 1,
              user_id = COALESCE(EXCLUDED.user_id, chat_daily_usage.user_id),
              updated_at = now()
            WHERE chat_daily_usage.free_form_count < $5
            RETURNING free_form_count
          `,
          [
            this.platform,
            input.externalUserId,
            input.userId ?? null,
            input.usageDate,
            input.dailyLimit,
          ],
        );

        if (!rows[0]) {
          throw new DailyLimitExceededError();
        }

        const freeFormCount = rows[0]?.free_form_count ?? 0;
        await this.hooks.onReserved?.(manager, {
          externalUserId: input.externalUserId,
          userId: input.userId,
          usageDate: input.usageDate,
          idempotencyKey: input.idempotencyKey,
          limit: input.dailyLimit,
          usedAfter: freeFormCount,
        });

        return {
          status: 'reserved',
          freeFormCount,
        };
      });
    } catch (error) {
      if (error instanceof DailyLimitExceededError) {
        return { status: 'daily_limit_exceeded' };
      }

      if (error instanceof BurstLimitExceededError) {
        return { status: 'burst_limit_exceeded', count: error.count };
      }

      throw error;
    }
  }

  async refundReservedSlot(params: {
    externalUserId: string;
    usageDate: string;
    idempotencyKey: string;
    releaseReason?: 'send_failed' | 'stuck_recover';
    userId?: number;
  }): Promise<boolean> {
    const releaseReason = params.releaseReason ?? 'send_failed';

    return this.dailyUsageRepo.manager.transaction(async (manager) => {
      const refundedRows: Array<{ idempotency_key: string }> =
        await manager.query(
          `
            UPDATE chat_idempotency
            SET status = 'refunded'
            WHERE platform = $1 AND idempotency_key = $2 AND status = 'reserved'
            RETURNING idempotency_key
          `,
          [this.platform, params.idempotencyKey],
        );

      if (!refundedRows[0]) {
        return false;
      }

      const usageRows: Array<{ free_form_count: number }> = await manager.query(
        `
          UPDATE chat_daily_usage
          SET
            free_form_count = GREATEST(free_form_count - 1, 0),
            updated_at = now()
          WHERE platform = $1 AND external_user_id = $2 AND usage_date = $3::date
          RETURNING free_form_count
        `,
        [this.platform, params.externalUserId, params.usageDate],
      );

      const usedAfter = usageRows[0]?.free_form_count ?? 0;
      await this.hooks.onReleased?.(manager, {
        externalUserId: params.externalUserId,
        userId: params.userId,
        usageDate: params.usageDate,
        idempotencyKey: params.idempotencyKey,
        reason: releaseReason,
        usedAfter,
      });

      return true;
    });
  }

  async completeReservedSlot(idempotencyKey: string): Promise<boolean> {
    const rows: Array<{ idempotency_key: string }> =
      await this.idempotencyRepo.manager.query(
        `
          UPDATE chat_idempotency
          SET status = 'completed'
          WHERE platform = $1 AND idempotency_key = $2 AND status = 'reserved'
          RETURNING idempotency_key
        `,
        [this.platform, idempotencyKey],
      );

    return rows.length > 0;
  }

  async countRecentReservations(
    externalUserId: string,
    since: Date,
    options: { includeRefunded?: boolean } = {},
  ): Promise<number> {
    const includeRefunded = options.includeRefunded ?? false;
    const statusFilter = includeRefunded
      ? ''
      : ` AND status IN ('reserved', 'completed')`;

    const rows: Array<{ count: string }> =
      await this.idempotencyRepo.manager.query(
        `
        SELECT COUNT(*)::text AS count
        FROM chat_idempotency
        WHERE platform = $1 AND external_user_id = $2 AND reserved_at > $3${statusFilter}
      `,
        [this.platform, externalUserId, since],
      );

    return Number(rows[0]?.count ?? 0);
  }

  async listStuckReserved(stuckBefore: Date): Promise<ChatIdempotencyRecord[]> {
    const rows: Array<{
      idempotency_key: string;
      external_user_id: string;
      user_id: number | null;
      usage_date: string;
      status: ChatIdempotencyStatus;
      reserved_at: Date;
    }> = await this.idempotencyRepo.manager.query(
      `
        SELECT
          idempotency_key,
          external_user_id,
          user_id,
          usage_date,
          status,
          reserved_at
        FROM chat_idempotency
        WHERE platform = $1 AND status = 'reserved' AND reserved_at < $2
        ORDER BY reserved_at ASC
      `,
      [this.platform, stuckBefore],
    );

    return rows.map((row) => this.mapIdempotency(row));
  }

  async recoverIdempotencyForRetry(
    idempotencyKey: string,
    stuckBefore: Date,
  ): Promise<RecoverIdempotencyOutcome> {
    return this.idempotencyRepo.manager.transaction(async (manager) => {
      const rows: Array<{
        idempotency_key: string;
        external_user_id: string;
        user_id: number | null;
        usage_date: string;
        status: ChatIdempotencyStatus;
        reserved_at: Date;
      }> = await manager.query(
        `
          SELECT
            idempotency_key,
            external_user_id,
            user_id,
            usage_date,
            status,
            reserved_at
          FROM chat_idempotency
          WHERE platform = $1 AND idempotency_key = $2
          FOR UPDATE
        `,
        [this.platform, idempotencyKey],
      );

      const row = rows[0];
      if (!row) {
        return 'not_found';
      }

      if (row.status === 'completed') {
        return 'completed';
      }

      if (row.status === 'reserved') {
        const reservedAt = new Date(row.reserved_at);
        if (reservedAt >= stuckBefore) {
          return 'in_flight';
        }

        const refundedRows: Array<{ idempotency_key: string }> =
          await manager.query(
            `
              UPDATE chat_idempotency
              SET status = 'refunded'
              WHERE platform = $1 AND idempotency_key = $2 AND status = 'reserved'
              RETURNING idempotency_key
            `,
            [this.platform, idempotencyKey],
          );

        if (!refundedRows[0]) {
          return 'not_found';
        }

        const usageRows: Array<{ free_form_count: number }> =
          await manager.query(
            `
            UPDATE chat_daily_usage
            SET
              free_form_count = GREATEST(free_form_count - 1, 0),
              updated_at = now()
            WHERE platform = $1 AND external_user_id = $2 AND usage_date = $3::date
            RETURNING free_form_count
          `,
            [this.platform, row.external_user_id, row.usage_date],
          );

        const usedAfter = usageRows[0]?.free_form_count ?? 0;
        await this.hooks.onReleased?.(manager, {
          externalUserId: row.external_user_id,
          userId: row.user_id ?? undefined,
          usageDate: row.usage_date,
          idempotencyKey,
          reason: 'stuck_recover',
          usedAfter,
        });

        await manager.query(
          `
            DELETE FROM chat_idempotency
            WHERE platform = $1 AND idempotency_key = $2
          `,
          [this.platform, idempotencyKey],
        );

        return 'reopened';
      }

      if (row.status === 'refunded') {
        await manager.query(
          `
            DELETE FROM chat_idempotency
            WHERE platform = $1 AND idempotency_key = $2
          `,
          [this.platform, idempotencyKey],
        );

        return 'reopened';
      }

      return 'not_found';
    });
  }

  async recoverAllStuckReserved(stuckBefore: Date): Promise<string[]> {
    const stuck = await this.listStuckReserved(stuckBefore);
    const recovered: string[] = [];

    for (const row of stuck) {
      const outcome = await this.recoverIdempotencyForRetry(
        row.idempotencyKey,
        stuckBefore,
      );
      if (outcome === 'reopened') {
        recovered.push(row.idempotencyKey);
      }
    }

    return recovered;
  }

  private mapIdempotency(row: {
    idempotency_key: string;
    external_user_id: string;
    user_id: number | null;
    usage_date: string;
    status: ChatIdempotencyStatus;
    reserved_at: Date;
  }): ChatIdempotencyRecord {
    return {
      idempotencyKey: row.idempotency_key,
      externalUserId: row.external_user_id,
      userId: row.user_id ?? undefined,
      usageDate: row.usage_date,
      status: row.status,
      reservedAt: row.reserved_at,
    };
  }
}
