/* eslint-disable @typescript-eslint/unbound-method -- Jest mock method assertions */
import { EntityManager, Repository } from 'typeorm';
import type { ChatDailyUsageEntity } from '../entities/chat-daily-usage.entity';
import type { ChatIdempotencyEntity } from '../entities/chat-idempotency.entity';
import {
  ChatRateLimitRepository,
  type ChatRateLimitRepositoryHooks,
} from './chat-rate-limit.repository';

type DailyUsageRow = {
  externalUserId: string;
  userId: number | null;
  usageDate: string;
  freeFormCount: number;
};

type IdempotencyRow = {
  idempotencyKey: string;
  externalUserId: string;
  userId: number | null;
  usageDate: string;
  status: 'reserved' | 'completed' | 'refunded';
  reservedAt: Date;
};

const PLATFORM = 'messenger';

describe('ChatRateLimitRepository', () => {
  let repository: ChatRateLimitRepository;
  let dailyUsageStore: Map<string, DailyUsageRow>;
  let idempotencyStore: Map<string, IdempotencyRow>;
  let hooks: jest.Mocked<ChatRateLimitRepositoryHooks>;

  const usageKey = (externalUserId: string, usageDate: string) =>
    `${externalUserId}:${usageDate}`;

  const createManager = (): EntityManager => {
    const manager = {
      query: jest.fn((sql: string, params: unknown[]) => {
        const normalized = sql.replace(/\s+/g, ' ').trim();

        if (normalized.startsWith('SELECT pg_advisory_xact_lock')) {
          return [];
        }

        if (
          normalized.startsWith(
            'INSERT INTO chat_daily_usage (platform, external_user_id, user_id, usage_date, free_form_count)',
          )
        ) {
          const externalUserId = params[1] as string;
          const userId = params[2] as number | null;
          const usageDate = params[3] as string;
          const dailyLimit = params[4] as number | undefined;
          const key = usageKey(externalUserId, usageDate);
          const existing = dailyUsageStore.get(key);
          const hasHardCap =
            typeof dailyLimit === 'number' &&
            normalized.includes('free_form_count <');

          if (!existing) {
            dailyUsageStore.set(key, {
              externalUserId,
              userId,
              usageDate,
              freeFormCount: 1,
            });
            return [{ free_form_count: 1 }];
          }

          if (hasHardCap && existing.freeFormCount >= dailyLimit) {
            return [];
          }

          existing.freeFormCount += 1;
          existing.userId = userId ?? existing.userId;
          return [{ free_form_count: existing.freeFormCount }];
        }

        if (
          normalized.startsWith(
            'UPDATE chat_daily_usage SET free_form_count = GREATEST(free_form_count - 1, 0)',
          )
        ) {
          const [, externalUserId, usageDate] = params as [
            string,
            string,
            string,
          ];
          const existing = dailyUsageStore.get(
            usageKey(externalUserId, usageDate),
          );
          if (!existing) {
            return [];
          }

          existing.freeFormCount = Math.max(existing.freeFormCount - 1, 0);
          return [{ free_form_count: existing.freeFormCount }];
        }

        if (
          normalized.startsWith(
            'SELECT COUNT(*)::text AS count FROM chat_idempotency',
          )
        ) {
          const [, externalUserId, since] = params as [string, string, Date];
          const includeRefunded = !normalized.includes(
            "status IN ('reserved', 'completed')",
          );
          const count = [...idempotencyStore.values()].filter((row) => {
            if (
              row.externalUserId !== externalUserId ||
              row.reservedAt <= since
            ) {
              return false;
            }

            if (includeRefunded) {
              return true;
            }

            return row.status === 'reserved' || row.status === 'completed';
          }).length;
          return [{ count: String(count) }];
        }

        if (normalized.startsWith('UPDATE chat_idempotency SET status = ')) {
          const [, idempotencyKey] = params as [string, string];
          const row = idempotencyStore.get(idempotencyKey);
          if (!row) {
            return [];
          }

          if (normalized.includes("SET status = 'refunded'")) {
            if (row.status !== 'reserved') {
              return [];
            }
            row.status = 'refunded';
            return [{ idempotency_key: idempotencyKey }];
          }

          if (normalized.includes("SET status = 'completed'")) {
            if (row.status !== 'reserved') {
              return [];
            }
            row.status = 'completed';
            return [{ idempotency_key: idempotencyKey }];
          }
        }

        if (
          normalized.startsWith(
            'INSERT INTO chat_idempotency ( idempotency_key, platform, external_user_id, user_id, usage_date, status )',
          )
        ) {
          const [idempotencyKey, , externalUserId, userId, usageDate] =
            params as [string, string, string, number | null, string];

          if (idempotencyStore.has(idempotencyKey)) {
            return [];
          }

          const row: IdempotencyRow = {
            idempotencyKey,
            externalUserId,
            userId,
            usageDate,
            status: 'reserved',
            reservedAt: new Date('2026-06-15T08:00:00+07:00'),
          };
          idempotencyStore.set(idempotencyKey, row);

          return [
            {
              idempotency_key: row.idempotencyKey,
              external_user_id: row.externalUserId,
              user_id: row.userId,
              usage_date: row.usageDate,
              status: row.status,
              reserved_at: row.reservedAt,
            },
          ];
        }

        if (
          normalized.includes('FROM chat_idempotency') &&
          normalized.includes('FOR UPDATE')
        ) {
          const [, idempotencyKey] = params as [string, string];
          const row = idempotencyStore.get(idempotencyKey);
          if (!row) {
            return [];
          }

          return [
            {
              idempotency_key: row.idempotencyKey,
              external_user_id: row.externalUserId,
              user_id: row.userId,
              usage_date: row.usageDate,
              status: row.status,
              reserved_at: row.reservedAt,
            },
          ];
        }

        if (
          normalized.startsWith(
            'DELETE FROM chat_idempotency WHERE platform = $1',
          )
        ) {
          const [, idempotencyKey] = params as [string, string];
          idempotencyStore.delete(idempotencyKey);
          return [];
        }

        if (
          normalized.includes(
            "WHERE platform = $1 AND status = 'reserved' AND reserved_at < $2",
          )
        ) {
          const [, stuckBefore] = params as [string, Date];
          return [...idempotencyStore.values()]
            .filter(
              (row) =>
                row.status === 'reserved' && row.reservedAt < stuckBefore,
            )
            .map((row) => ({
              idempotency_key: row.idempotencyKey,
              external_user_id: row.externalUserId,
              user_id: row.userId,
              usage_date: row.usageDate,
              status: row.status,
              reserved_at: row.reservedAt,
            }));
        }

        throw new Error(`Unexpected SQL in test: ${normalized}`);
      }),
      transaction: jest.fn(
        async <T>(work: (txManager: EntityManager) => Promise<T>) => {
          const idempotencySnapshot = new Map(idempotencyStore);
          const dailySnapshot = new Map(dailyUsageStore);
          try {
            return await work(manager);
          } catch (error) {
            idempotencyStore.clear();
            idempotencySnapshot.forEach((value, key) =>
              idempotencyStore.set(key, value),
            );
            dailyUsageStore.clear();
            dailySnapshot.forEach((value, key) =>
              dailyUsageStore.set(key, value),
            );
            throw error;
          }
        },
      ),
    } as unknown as EntityManager;

    return manager;
  };

  beforeEach(() => {
    dailyUsageStore = new Map();
    idempotencyStore = new Map();

    const manager = createManager();
    const dailyUsageRepo = {
      findOne: jest.fn(
        ({
          where,
        }: {
          where: {
            platform: string;
            externalUserId: string;
            usageDate: string;
          };
        }) => {
          const row = dailyUsageStore.get(
            usageKey(where.externalUserId, where.usageDate),
          );
          if (!row) {
            return Promise.resolve(null);
          }

          return Promise.resolve({
            freeFormCount: row.freeFormCount,
          });
        },
      ),
      manager,
    } as unknown as Repository<ChatDailyUsageEntity>;

    const idempotencyRepo = {
      manager,
    } as unknown as Repository<ChatIdempotencyEntity>;

    hooks = {
      onReserved: jest.fn(() => Promise.resolve()),
      onReleased: jest.fn(() => Promise.resolve()),
    };

    repository = new ChatRateLimitRepository(
      dailyUsageRepo,
      idempotencyRepo,
      PLATFORM,
      hooks,
    );
  });

  it('returns zero when no daily usage row exists', async () => {
    await expect(
      repository.getDailyUsageCount('ext-1', '2026-06-15'),
    ).resolves.toBe(0);
  });

  it('inserts idempotency once and rejects duplicate key', async () => {
    const input = {
      idempotencyKey: 'mid-123',
      externalUserId: 'ext-1',
      userId: 143,
      usageDate: '2026-06-15',
    };

    const first = await repository.tryReserveIdempotency(input);
    const second = await repository.tryReserveIdempotency(input);

    expect(first).toEqual({
      idempotencyKey: 'mid-123',
      externalUserId: 'ext-1',
      userId: 143,
      usageDate: '2026-06-15',
      status: 'reserved',
      reservedAt: new Date('2026-06-15T08:00:00+07:00'),
    });
    expect(second).toBeNull();
  });

  const reserveInput = (
    overrides: Partial<{
      idempotencyKey: string;
      externalUserId: string;
      userId: number;
      usageDate: string;
      dailyLimit: number;
      burstLimit?: number;
      burstSince?: Date;
    }> = {},
  ) => ({
    idempotencyKey: 'mid-tx',
    externalUserId: 'ext-1',
    userId: 143,
    usageDate: '2026-06-15',
    dailyLimit: 15,
    burstLimit: undefined,
    burstSince: undefined,
    ...overrides,
  });

  it('reserves slot in one transaction with idempotency and usage increment', async () => {
    const outcome = await repository.reserveFreeFormSlotInTransaction(
      reserveInput({ idempotencyKey: 'mid-tx' }),
    );

    expect(outcome).toEqual({ status: 'reserved', freeFormCount: 1 });
    expect(idempotencyStore.get('mid-tx')?.status).toBe('reserved');
    await expect(
      repository.getDailyUsageCount('ext-1', '2026-06-15'),
    ).resolves.toBe(1);
    expect(hooks.onReserved).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        externalUserId: 'ext-1',
        idempotencyKey: 'mid-tx',
        usedAfter: 1,
        limit: 15,
      }),
    );
  });

  it('returns idempotency conflict without incrementing usage', async () => {
    await repository.reserveFreeFormSlotInTransaction(
      reserveInput({ idempotencyKey: 'mid-dup' }),
    );

    const second = await repository.reserveFreeFormSlotInTransaction(
      reserveInput({ idempotencyKey: 'mid-dup' }),
    );

    expect(second).toEqual({ status: 'idempotency_conflict' });
    await expect(
      repository.getDailyUsageCount('ext-1', '2026-06-15'),
    ).resolves.toBe(1);
  });

  it('refunds reserved slot and decrements usage', async () => {
    await repository.reserveFreeFormSlotInTransaction(
      reserveInput({ idempotencyKey: 'mid-refund' }),
    );

    const refunded = await repository.refundReservedSlot({
      idempotencyKey: 'mid-refund',
      externalUserId: 'ext-1',
      usageDate: '2026-06-15',
    });

    expect(refunded).toBe(true);
    expect(idempotencyStore.get('mid-refund')?.status).toBe('refunded');
    await expect(
      repository.getDailyUsageCount('ext-1', '2026-06-15'),
    ).resolves.toBe(0);
    expect(hooks.onReleased).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        externalUserId: 'ext-1',
        idempotencyKey: 'mid-refund',
        reason: 'send_failed',
        usedAfter: 0,
      }),
    );
  });

  it('completes reserved idempotency without decrementing usage', async () => {
    await repository.reserveFreeFormSlotInTransaction(
      reserveInput({ idempotencyKey: 'mid-complete' }),
    );

    const completed = await repository.completeReservedSlot('mid-complete');

    expect(completed).toBe(true);
    expect(idempotencyStore.get('mid-complete')?.status).toBe('completed');
    await expect(
      repository.getDailyUsageCount('ext-1', '2026-06-15'),
    ).resolves.toBe(1);
  });

  it('counts recent reservations inside the burst window', async () => {
    const now = Date.now();
    idempotencyStore.set('mid-1', {
      idempotencyKey: 'mid-1',
      externalUserId: 'ext-1',
      userId: null,
      usageDate: '2026-06-15',
      status: 'completed',
      reservedAt: new Date(now - 30_000),
    });
    idempotencyStore.set('mid-2', {
      idempotencyKey: 'mid-2',
      externalUserId: 'ext-1',
      userId: null,
      usageDate: '2026-06-15',
      status: 'reserved',
      reservedAt: new Date(now - 120_000),
    });

    await expect(
      repository.countRecentReservations('ext-1', new Date(now - 60_000)),
    ).resolves.toBe(1);
  });

  it('excludes refunded rows from burst count by default', async () => {
    const now = Date.now();
    idempotencyStore.set('mid-refunded', {
      idempotencyKey: 'mid-refunded',
      externalUserId: 'ext-1',
      userId: null,
      usageDate: '2026-06-15',
      status: 'refunded',
      reservedAt: new Date(now - 30_000),
    });
    idempotencyStore.set('mid-active', {
      idempotencyKey: 'mid-active',
      externalUserId: 'ext-1',
      userId: null,
      usageDate: '2026-06-15',
      status: 'completed',
      reservedAt: new Date(now - 20_000),
    });

    await expect(
      repository.countRecentReservations('ext-1', new Date(now - 60_000)),
    ).resolves.toBe(1);
    await expect(
      repository.countRecentReservations('ext-1', new Date(now - 60_000), {
        includeRefunded: true,
      }),
    ).resolves.toBe(2);
  });

  it('reopens stale reserved idempotency and refunds usage', async () => {
    const staleAt = new Date('2026-06-15T07:00:00+07:00');
    idempotencyStore.set('mid-stuck', {
      idempotencyKey: 'mid-stuck',
      externalUserId: 'ext-1',
      userId: 143,
      usageDate: '2026-06-15',
      status: 'reserved',
      reservedAt: staleAt,
    });
    dailyUsageStore.set('ext-1:2026-06-15', {
      externalUserId: 'ext-1',
      userId: 143,
      usageDate: '2026-06-15',
      freeFormCount: 1,
    });

    const outcome = await repository.recoverIdempotencyForRetry(
      'mid-stuck',
      new Date('2026-06-15T08:00:00+07:00'),
    );

    expect(outcome).toBe('reopened');
    expect(idempotencyStore.has('mid-stuck')).toBe(false);
    await expect(
      repository.getDailyUsageCount('ext-1', '2026-06-15'),
    ).resolves.toBe(0);
  });

  it('keeps in-flight reserved idempotency inside TTL', async () => {
    idempotencyStore.set('mid-flight', {
      idempotencyKey: 'mid-flight',
      externalUserId: 'ext-1',
      userId: null,
      usageDate: '2026-06-15',
      status: 'reserved',
      reservedAt: new Date('2026-06-15T08:30:00+07:00'),
    });

    const outcome = await repository.recoverIdempotencyForRetry(
      'mid-flight',
      new Date('2026-06-15T08:00:00+07:00'),
    );

    expect(outcome).toBe('in_flight');
    expect(idempotencyStore.get('mid-flight')?.status).toBe('reserved');
  });

  it('reopens refunded idempotency for retry', async () => {
    idempotencyStore.set('mid-retry', {
      idempotencyKey: 'mid-retry',
      externalUserId: 'ext-1',
      userId: null,
      usageDate: '2026-06-15',
      status: 'refunded',
      reservedAt: new Date('2026-06-15T08:00:00+07:00'),
    });

    const outcome = await repository.recoverIdempotencyForRetry(
      'mid-retry',
      new Date('2026-06-15T08:00:00+07:00'),
    );

    expect(outcome).toBe('reopened');
    expect(idempotencyStore.has('mid-retry')).toBe(false);
  });

  it('allows reserve again after recovering stale reserved key', async () => {
    const staleAt = new Date('2026-06-15T07:00:00+07:00');
    idempotencyStore.set('mid-stuck', {
      idempotencyKey: 'mid-stuck',
      externalUserId: 'ext-1',
      userId: null,
      usageDate: '2026-06-15',
      status: 'reserved',
      reservedAt: staleAt,
    });
    dailyUsageStore.set('ext-1:2026-06-15', {
      externalUserId: 'ext-1',
      userId: null,
      usageDate: '2026-06-15',
      freeFormCount: 1,
    });

    await repository.recoverIdempotencyForRetry(
      'mid-stuck',
      new Date('2026-06-15T08:00:00+07:00'),
    );

    const outcome = await repository.reserveFreeFormSlotInTransaction(
      reserveInput({ idempotencyKey: 'mid-stuck', userId: undefined }),
    );

    expect(outcome).toEqual({ status: 'reserved', freeFormCount: 1 });
  });

  it('denies reserve at daily hard cap without leaving idempotency row', async () => {
    dailyUsageStore.set('ext-1:2026-06-15', {
      externalUserId: 'ext-1',
      userId: null,
      usageDate: '2026-06-15',
      freeFormCount: 15,
    });

    const outcome = await repository.reserveFreeFormSlotInTransaction(
      reserveInput({ idempotencyKey: 'mid-cap', dailyLimit: 15 }),
    );

    expect(outcome).toEqual({ status: 'daily_limit_exceeded' });
    expect(idempotencyStore.has('mid-cap')).toBe(false);
    await expect(
      repository.getDailyUsageCount('ext-1', '2026-06-15'),
    ).resolves.toBe(15);
  });

  it('enforces the burst limit inside the reserve transaction', async () => {
    idempotencyStore.set('mid-existing', {
      idempotencyKey: 'mid-existing',
      externalUserId: 'ext-1',
      userId: null,
      usageDate: '2026-06-15',
      status: 'completed',
      reservedAt: new Date('2026-06-15T08:00:00+07:00'),
    });

    const outcome = await repository.reserveFreeFormSlotInTransaction(
      reserveInput({
        idempotencyKey: 'mid-burst',
        burstLimit: 1,
        burstSince: new Date('2026-06-14T08:00:00+07:00'),
      }),
    );

    expect(outcome).toEqual({ status: 'burst_limit_exceeded', count: 2 });
    expect(idempotencyStore.has('mid-burst')).toBe(false);
  });

  it('allows only one concurrent reserve when at daily limit minus one', async () => {
    dailyUsageStore.set('ext-1:2026-06-15', {
      externalUserId: 'ext-1',
      userId: null,
      usageDate: '2026-06-15',
      freeFormCount: 14,
    });

    const [first, second] = await Promise.all([
      repository.reserveFreeFormSlotInTransaction(
        reserveInput({ idempotencyKey: 'mid-a', dailyLimit: 15 }),
      ),
      repository.reserveFreeFormSlotInTransaction(
        reserveInput({ idempotencyKey: 'mid-b', dailyLimit: 15 }),
      ),
    ]);

    const outcomes = [first, second];
    expect(outcomes.filter((item) => item.status === 'reserved')).toHaveLength(
      1,
    );
    expect(
      outcomes.filter((item) => item.status === 'daily_limit_exceeded'),
    ).toHaveLength(1);
    await expect(
      repository.getDailyUsageCount('ext-1', '2026-06-15'),
    ).resolves.toBe(15);
  });
});
