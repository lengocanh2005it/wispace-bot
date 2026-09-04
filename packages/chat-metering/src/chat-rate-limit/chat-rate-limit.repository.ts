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
  LearnerUsageQueryFactory,
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

type QueryRows<T> = T[] | [T[], number];

export interface BurstCountRow {
  externalUserId: string;
  count: number;
}

function extractQueryRows<T>(result: QueryRows<T>): T[] {
  // TypeORM returns UPDATE/DELETE results as [rows, affected], unlike SELECT/INSERT.
  return Array.isArray(result[0]) ? result[0] : (result as T[]);
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
    private readonly learnerUsageQuery?: LearnerUsageQueryFactory,
  ) {}

  async getDailyUsageCount(
    externalUserId: string,
    usageDate: string,
    userId?: number,
  ): Promise<number> {
    if (userId !== undefined) {
      return this.getLearnerUsageCount(this.dailyUsageRepo.manager, {
        usageDate,
        userId,
        platform: this.platform,
        externalUserId,
      });
    }

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
        if (input.userId !== undefined) {
          await manager.query(
            'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
            [`chat-quota:user:${input.userId}:${input.usageDate}`],
          );
        }

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
          const burstStatuses = input.burstCountsRefunded
            ? "'reserved', 'delivered', 'completed', 'refunded'"
            : "'reserved', 'delivered', 'completed'";
          const burstRows: Array<{ count: string }> = await manager.query(
            `
              SELECT COUNT(*)::text AS count
              FROM chat_idempotency
              WHERE platform = $1 AND external_user_id = $2
                AND reserved_at > $3
                AND status IN (${burstStatuses})
            `,
            [this.platform, input.externalUserId, input.burstSince],
          );
          const count = Number(burstRows[0]?.count ?? 0);
          if (count > input.burstLimit) {
            throw new BurstLimitExceededError(count);
          }
        }

        let rows: Array<{ free_form_count: number }>;
        if (input.userId !== undefined) {
          // The user lock makes the aggregate check and the channel-row
          // increment one learner-scoped critical section. Legacy anonymous
          // usage on this channel is included once, then adopted by the link.
          const usedBefore = await this.getLearnerUsageCount(manager, {
            usageDate: input.usageDate,
            userId: input.userId,
            platform: this.platform,
            externalUserId: input.externalUserId,
          });
          if (usedBefore >= input.dailyLimit) {
            throw new DailyLimitExceededError();
          }

          rows = await manager.query(
            `
              INSERT INTO chat_daily_usage (platform, external_user_id, user_id, usage_date, free_form_count)
              VALUES ($1, $2, $3, $4::date, 1)
              ON CONFLICT (platform, external_user_id, usage_date)
              DO UPDATE SET
                free_form_count = CASE
                  WHEN chat_daily_usage.user_id IS NOT NULL
                    AND chat_daily_usage.user_id IS DISTINCT FROM EXCLUDED.user_id
                  THEN 1
                  ELSE chat_daily_usage.free_form_count + 1
                END,
                user_id = EXCLUDED.user_id,
                updated_at = now()
              RETURNING free_form_count
            `,
            [
              this.platform,
              input.externalUserId,
              input.userId,
              input.usageDate,
            ],
          );
        } else {
          rows = await manager.query(
            `
              INSERT INTO chat_daily_usage (platform, external_user_id, user_id, usage_date, free_form_count)
              VALUES ($1, $2, $3, $4::date, 1)
              ON CONFLICT (platform, external_user_id, usage_date)
              DO UPDATE SET
                -- An unlinked channel starts a fresh anonymous bucket instead
                -- of inheriting a prior learner-owned counter after unlink.
                free_form_count = CASE
                  WHEN chat_daily_usage.user_id IS NULL
                  THEN chat_daily_usage.free_form_count + 1
                  ELSE 1
                END,
                user_id = NULL,
                updated_at = now()
              WHERE chat_daily_usage.user_id IS NOT NULL
                OR chat_daily_usage.free_form_count < $5
              RETURNING free_form_count
            `,
            [
              this.platform,
              input.externalUserId,
              null,
              input.usageDate,
              input.dailyLimit,
            ],
          );
        }

        if (!rows[0]) {
          throw new DailyLimitExceededError();
        }

        let freeFormCount = rows[0]?.free_form_count ?? 0;
        if (input.userId !== undefined) {
          freeFormCount = await this.getLearnerUsageCount(manager, {
            usageDate: input.usageDate,
            userId: input.userId,
            platform: this.platform,
            externalUserId: input.externalUserId,
          });
        }
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
      const refundedRows = extractQueryRows<{
        idempotency_key: string;
        external_user_id?: string;
        usage_date?: string;
        user_id?: number | null;
      }>(
        await manager.query(
          `
            UPDATE chat_idempotency
            SET status = 'refunded'
            WHERE platform = $1 AND idempotency_key = $2 AND status = 'reserved'
            RETURNING idempotency_key, external_user_id, usage_date, user_id
          `,
          [this.platform, params.idempotencyKey],
        ),
      );

      if (!refundedRows[0]) {
        return false;
      }

      // The persisted idempotency owner is authoritative. Only old test/DB
      // drivers that omit the returned column may fall back to the caller.
      const ownerUserId =
        refundedRows[0].user_id === undefined
          ? params.userId
          : (refundedRows[0].user_id ?? undefined);
      const externalUserId =
        refundedRows[0].external_user_id ?? params.externalUserId;
      const usageDate = refundedRows[0].usage_date ?? params.usageDate;
      const usageRows = extractQueryRows<{ free_form_count: number }>(
        await manager.query(
          ownerUserId !== undefined
            ? `
              UPDATE chat_daily_usage
              SET
                free_form_count = GREATEST(free_form_count - 1, 0),
                updated_at = now()
              WHERE platform = $1 AND external_user_id = $2
                AND usage_date = $3::date AND user_id = $4
              RETURNING free_form_count
            `
            : `
              UPDATE chat_daily_usage
              SET
                free_form_count = GREATEST(free_form_count - 1, 0),
                updated_at = now()
              WHERE platform = $1 AND external_user_id = $2 AND usage_date = $3::date
              RETURNING free_form_count
            `,
          ownerUserId !== undefined
            ? [this.platform, externalUserId, usageDate, ownerUserId]
            : [this.platform, externalUserId, usageDate],
        ),
      );

      let usedAfter = usageRows[0]?.free_form_count ?? 0;
      if (ownerUserId !== undefined) {
        usedAfter = await this.getLearnerUsageCount(manager, {
          usageDate,
          userId: ownerUserId,
          platform: this.platform,
          externalUserId,
        });
      }
      await this.hooks.onReleased?.(manager, {
        externalUserId,
        userId: ownerUserId,
        usageDate,
        idempotencyKey: params.idempotencyKey,
        reason: releaseReason,
        usedAfter,
      });

      return true;
    });
  }

  async completeReservedSlot(idempotencyKey: string): Promise<boolean> {
    const rows = extractQueryRows<{ idempotency_key: string }>(
      await this.idempotencyRepo.manager.query(
        `
          UPDATE chat_idempotency
          SET status = 'completed'
          WHERE platform = $1
            AND idempotency_key = $2
            AND status IN ('reserved', 'delivered')
          RETURNING idempotency_key
        `,
        [this.platform, idempotencyKey],
      ),
    );

    return rows.length > 0;
  }

  async markDeliveredSlot(idempotencyKey: string): Promise<boolean> {
    const rows = extractQueryRows<{ idempotency_key: string }>(
      await this.idempotencyRepo.manager.query(
        `
          UPDATE chat_idempotency
          SET status = 'delivered'
          WHERE platform = $1 AND idempotency_key = $2 AND status = 'reserved'
          RETURNING idempotency_key
        `,
        [this.platform, idempotencyKey],
      ),
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
      : ` AND status IN ('reserved', 'delivered', 'completed')`;

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

  /**
   * Bounded, fixed-bucket view used only by the Redis consistency audit.
   * The reserve transaction remains the sliding-window policy authority.
   */
  async listBurstCountsForBucket(
    bucketStart: Date,
    bucketEnd: Date,
    options: { includeRefunded?: boolean; limit?: number } = {},
  ): Promise<{ rows: BurstCountRow[]; truncated: boolean }> {
    const includeRefunded = options.includeRefunded ?? false;
    const limit = Math.max(1, Math.floor(options.limit ?? 100));
    const countExpression = includeRefunded
      ? 'COUNT(*)'
      : `COUNT(*) FILTER (WHERE status IN ('reserved', 'delivered', 'completed'))`;
    const rows: Array<{ external_user_id: string; count: string }> =
      await this.idempotencyRepo.manager.query(
        `
        SELECT external_user_id, ${countExpression}::text AS count
        FROM chat_idempotency
        WHERE platform = $1 AND reserved_at >= $2 AND reserved_at < $3
        GROUP BY external_user_id
        ORDER BY external_user_id
        LIMIT $4
      `,
        [this.platform, bucketStart, bucketEnd, limit + 1],
      );

    const truncated = rows.length > limit;
    return {
      rows: rows.slice(0, limit).map((row) => ({
        externalUserId: row.external_user_id,
        count: Number(row.count),
      })),
      truncated,
    };
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

      if (row.status === 'delivered') {
        return 'delivered';
      }

      if (row.status === 'reserved') {
        const reservedAt = new Date(row.reserved_at);
        if (reservedAt >= stuckBefore) {
          return 'in_flight';
        }

        const refundedRows = extractQueryRows<{ idempotency_key: string }>(
          await manager.query(
            `
              UPDATE chat_idempotency
              SET status = 'refunded'
              WHERE platform = $1 AND idempotency_key = $2 AND status = 'reserved'
              RETURNING idempotency_key
            `,
            [this.platform, idempotencyKey],
          ),
        );

        if (!refundedRows[0]) {
          return 'not_found';
        }

        const ownerUserId = row.user_id ?? undefined;
        const usageRows = extractQueryRows<{ free_form_count: number }>(
          await manager.query(
            ownerUserId !== undefined
              ? `
                UPDATE chat_daily_usage
                SET
                  free_form_count = GREATEST(free_form_count - 1, 0),
                  updated_at = now()
                WHERE platform = $1 AND external_user_id = $2
                  AND usage_date = $3::date AND user_id = $4
                RETURNING free_form_count
              `
              : `
                UPDATE chat_daily_usage
                SET
                  free_form_count = GREATEST(free_form_count - 1, 0),
                  updated_at = now()
                WHERE platform = $1 AND external_user_id = $2 AND usage_date = $3::date
                RETURNING free_form_count
              `,
            ownerUserId !== undefined
              ? [
                  this.platform,
                  row.external_user_id,
                  row.usage_date,
                  ownerUserId,
                ]
              : [this.platform, row.external_user_id, row.usage_date],
          ),
        );

        let usedAfter = usageRows[0]?.free_form_count ?? 0;
        if (ownerUserId !== undefined) {
          usedAfter = await this.getLearnerUsageCount(manager, {
            usageDate: row.usage_date,
            userId: ownerUserId,
            platform: this.platform,
            externalUserId: row.external_user_id,
          });
        }
        await this.hooks.onReleased?.(manager, {
          externalUserId: row.external_user_id,
          userId: ownerUserId,
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
    return this.idempotencyRepo.manager.transaction(async (manager) => {
      const deliveredRows = extractQueryRows<{
        idempotency_key: string;
      }>(
        await manager.query(
          `
            UPDATE chat_idempotency
            SET status = 'completed', updated_at = NOW()
            WHERE platform = $1
              AND status = 'delivered'
              AND reserved_at < $2
            RETURNING idempotency_key
          `,
          [this.platform, stuckBefore],
        ),
      );

      const rows = extractQueryRows<{
        idempotency_key: string;
        external_user_id: string;
        user_id: number | null;
        usage_date: string;
      }>(
        await manager.query(
          `
            UPDATE chat_idempotency
            SET status = 'refunded', updated_at = NOW()
            WHERE platform = $1
              AND status = 'reserved'
              AND reserved_at < $2
            RETURNING idempotency_key, external_user_id, user_id, usage_date
          `,
          [this.platform, stuckBefore],
        ),
      );

      if (rows.length === 0) {
        return deliveredRows.map((row) => row.idempotency_key);
      }

      // Decrement daily usage counters in bounded pages to stay under
      // PostgreSQL's 65 535-parameter limit (4 params per group → 16 383
      // groups max at one shot). Processing in 1 000-row pages keeps the
      // parameter count at 4 000 — well within budget.
      const PAGE_SIZE = 1000;

      for (let offset = 0; offset < rows.length; offset += PAGE_SIZE) {
        const page = rows.slice(offset, offset + PAGE_SIZE);
        const anonymousUsageDecrement = new Map<string, number>();
        const learnerUsageDecrement = new Map<string, number>();

        for (const row of page) {
          const rawUsageDate = row.usage_date as unknown;
          const usageDate =
            rawUsageDate instanceof Date
              ? rawUsageDate.toISOString().slice(0, 10)
              : String(row.usage_date ?? '').slice(0, 10);
          if (row.user_id !== null && row.user_id !== undefined) {
            const key = `${usageDate}:${row.user_id}:${row.external_user_id}`;
            learnerUsageDecrement.set(
              key,
              (learnerUsageDecrement.get(key) ?? 0) + 1,
            );
          } else {
            const key = `${usageDate}:${row.external_user_id}`;
            anonymousUsageDecrement.set(
              key,
              (anonymousUsageDecrement.get(key) ?? 0) + 1,
            );
          }
        }

        if (
          anonymousUsageDecrement.size === 0 &&
          learnerUsageDecrement.size === 0
        ) {
          continue;
        }

        if (anonymousUsageDecrement.size > 0) {
          const entries = [...anonymousUsageDecrement.entries()];
          const valuesClauses: string[] = [];
          const params: unknown[] = [];
          let paramIndex = 1;

          for (const [key, count] of entries) {
            const [usageDateRaw, externalUserId] = key.split(':');
            const usageDate = String(usageDateRaw ?? '').slice(0, 10);
            valuesClauses.push(
              `($${paramIndex}::varchar, $${paramIndex + 1}::date, $${paramIndex + 2}::varchar, $${paramIndex + 3}::int)`,
            );
            params.push(this.platform, usageDate, externalUserId, count);
            paramIndex += 4;
          }

          await manager.query(
            `
              UPDATE chat_daily_usage
              SET free_form_count = GREATEST(0, free_form_count - v.delta)
              FROM (VALUES ${valuesClauses.join(', ')}) AS v(platform, usage_date, external_user_id, delta)
              WHERE chat_daily_usage.platform = v.platform
                AND chat_daily_usage.usage_date = v.usage_date
                AND chat_daily_usage.external_user_id = v.external_user_id
            `,
            params,
          );
        }

        if (learnerUsageDecrement.size > 0) {
          const entries = [...learnerUsageDecrement.entries()];
          const valuesClauses: string[] = [];
          const params: unknown[] = [];
          let paramIndex = 1;

          for (const [key, count] of entries) {
            const [usageDateRaw, userIdRaw, externalUserId] = key.split(':');
            const usageDate = String(usageDateRaw ?? '').slice(0, 10);
            valuesClauses.push(
              `($${paramIndex}::varchar, $${paramIndex + 1}::date, $${paramIndex + 2}::int, $${paramIndex + 3}::varchar, $${paramIndex + 4}::int)`,
            );
            params.push(
              this.platform,
              usageDate,
              Number(userIdRaw),
              externalUserId,
              count,
            );
            paramIndex += 5;
          }

          await manager.query(
            `
              UPDATE chat_daily_usage
              SET free_form_count = GREATEST(0, free_form_count - v.delta)
              FROM (VALUES ${valuesClauses.join(', ')}) AS v(platform, usage_date, user_id, external_user_id, delta)
              WHERE chat_daily_usage.platform = v.platform
                AND chat_daily_usage.user_id = v.user_id
                AND chat_daily_usage.usage_date = v.usage_date
                AND chat_daily_usage.external_user_id = v.external_user_id
            `,
            params,
          );
        }
      }

      return [
        ...deliveredRows.map((row) => row.idempotency_key),
        ...rows.map((r) => r.idempotency_key),
      ];
    });
  }

  private async getLearnerUsageCount(
    manager: EntityManager,
    input: Parameters<NonNullable<LearnerUsageQueryFactory>>[0],
  ): Promise<number> {
    if (!this.learnerUsageQuery) {
      throw new Error('Learner usage query is not configured');
    }
    const query = this.learnerUsageQuery(input);
    const rows: Array<{ used: string | number }> = await manager.query(
      query.sql,
      query.params,
    );
    return Number(rows[0]?.used ?? 0);
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
