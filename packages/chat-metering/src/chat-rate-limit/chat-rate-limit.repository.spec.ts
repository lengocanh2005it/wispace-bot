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
  status: 'reserved' | 'delivered' | 'completed' | 'refunded';
  reservedAt: Date;
};

const PLATFORM = 'messenger';

const updateResult = <T>(rows: T[]): [T[], number] => [rows, rows.length];

/** Every normalized statement the fake driver executed, in order. */
let recordedSql: string[] = [];

/**
 * Owner-aware key: a learner row and an anonymous row for the same channel and
 * date are distinct rows (#1177).
 */
const usageKey = (
  externalUserId: string,
  usageDate: string,
  userId?: number | null,
) => `${externalUserId}:${usageDate}:${userId ?? 'anonymous'}`;

describe('ChatRateLimitRepository', () => {
  let repository: ChatRateLimitRepository;
  let dailyUsageStore: Map<string, DailyUsageRow>;
  let idempotencyStore: Map<string, IdempotencyRow>;
  let hooks: jest.Mocked<ChatRateLimitRepositoryHooks>;
  let serializeTransactions: boolean;

  const seedUsage = (row: DailyUsageRow): void => {
    dailyUsageStore.set(
      usageKey(row.externalUserId, row.usageDate, row.userId),
      row,
    );
  };

  const readUsage = (
    externalUserId: string,
    usageDate: string,
    userId?: number | null,
  ): DailyUsageRow | undefined =>
    dailyUsageStore.get(usageKey(externalUserId, usageDate, userId));

  const learnerUsageQuery = (input: { usageDate: string; userId: number }) => ({
    sql: 'SELECT COALESCE(SUM(free_form_count), 0)::int AS used',
    params: [input.usageDate, input.userId],
  });

  const createManager = (): EntityManager => {
    let transactionTail: Promise<void> = Promise.resolve();
    const advisoryLockTails = new Map<string, Promise<void>>();

    const acquireAdvisoryLock = async (key: string): Promise<() => void> => {
      const previous = advisoryLockTails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.then(() => current);
      advisoryLockTails.set(key, tail);
      await previous;

      return () => {
        release();
        if (advisoryLockTails.get(key) === tail) {
          advisoryLockTails.delete(key);
        }
      };
    };

    const manager = {
      query: jest.fn((sql: string, params: unknown[]) => {
        const normalized = sql.replace(/\s+/g, ' ').trim();
        recordedSql.push(normalized);

        if (normalized.startsWith('SELECT pg_advisory_xact_lock')) {
          return [];
        }

        if (normalized.includes('COALESCE(SUM(')) {
          const usageDate = params[0] as string;
          const userId = params[1] as number;
          // Learner bucket only — anonymous rows are never adopted (#1177).
          const used = [...dailyUsageStore.values()]
            .filter(
              (row) => row.usageDate === usageDate && row.userId === userId,
            )
            .reduce((sum, row) => sum + row.freeFormCount, 0);
          return [{ used: String(used) }];
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
          const targetsAnonymousRow = normalized.includes(
            'WHERE user_id IS NULL',
          );
          const key = usageKey(externalUserId, usageDate, userId);
          const existing = dailyUsageStore.get(key);

          if (!existing) {
            dailyUsageStore.set(key, {
              externalUserId,
              userId,
              usageDate,
              freeFormCount: 1,
            });
            return [{ free_form_count: 1 }];
          }

          // The anonymous path keeps its hard cap inside the upsert; the linked
          // path relies on the learner/date lock taken before the write.
          if (
            targetsAnonymousRow &&
            typeof dailyLimit === 'number' &&
            existing.freeFormCount >= dailyLimit
          ) {
            return [];
          }

          existing.freeFormCount += 1;
          return [{ free_form_count: existing.freeFormCount }];
        }

        if (
          normalized.startsWith(
            'UPDATE chat_daily_usage SET free_form_count = GREATEST(free_form_count - 1, 0)',
          )
        ) {
          const [, externalUserId, usageDate, ownerUserId] = params as [
            string,
            string,
            string,
            number | undefined,
          ];
          const targetsAnonymousRow = normalized.includes('user_id IS NULL');
          const existing = dailyUsageStore.get(
            usageKey(
              externalUserId,
              usageDate,
              targetsAnonymousRow ? null : ownerUserId,
            ),
          );
          if (!existing) {
            return updateResult([]);
          }

          existing.freeFormCount = Math.max(existing.freeFormCount - 1, 0);
          return updateResult([{ free_form_count: existing.freeFormCount }]);
        }

        if (
          normalized.startsWith(
            'UPDATE chat_daily_usage SET free_form_count = GREATEST(0, free_form_count - v.delta)',
          )
        ) {
          const anonymousBatch = normalized.includes(
            'chat_daily_usage.user_id IS NULL',
          );
          const stride = anonymousBatch ? 4 : 5;
          let updatedRows = 0;

          for (let index = 0; index < params.length; index += stride) {
            const usageDate = params[index + 1] as string;
            const userId = anonymousBatch
              ? null
              : (params[index + 2] as number);
            const externalUserId = params[index + (anonymousBatch ? 2 : 3)] as
              | string
              | undefined;
            const delta = params[index + (anonymousBatch ? 3 : 4)] as number;

            const row = dailyUsageStore.get(
              usageKey(externalUserId ?? '', usageDate, userId),
            );
            if (!row) {
              continue;
            }

            row.freeFormCount = Math.max(row.freeFormCount - delta, 0);
            updatedRows += 1;
          }

          return [[], updatedRows] as [unknown[], number];
        }

        if (
          normalized.startsWith(
            'SELECT COUNT(*)::text AS count FROM chat_idempotency',
          )
        ) {
          const [, externalUserId, since] = params as [string, string, Date];
          const includeRefunded = !normalized.includes(
            "status IN ('reserved', 'delivered', 'completed')",
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

            return (
              row.status === 'reserved' ||
              row.status === 'delivered' ||
              row.status === 'completed'
            );
          }).length;
          return [{ count: String(count) }];
        }

        if (normalized.startsWith('SELECT external_user_id, COUNT(*)')) {
          const [, bucketStart, bucketEnd, requestedLimit] = params as [
            string,
            Date,
            Date,
            number,
          ];
          const includeRefunded = normalized.includes('COUNT(*)::text');
          const counts = new Map<string, number>();
          for (const row of idempotencyStore.values()) {
            if (row.reservedAt < bucketStart || row.reservedAt >= bucketEnd) {
              continue;
            }
            if (includeRefunded || row.status !== 'refunded') {
              counts.set(
                row.externalUserId,
                (counts.get(row.externalUserId) ?? 0) + 1,
              );
            } else if (!counts.has(row.externalUserId)) {
              counts.set(row.externalUserId, 0);
            }
          }
          return [...counts.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .slice(0, requestedLimit)
            .map(([externalUserId, count]) => ({
              external_user_id: externalUserId,
              count: String(count),
            }));
        }

        if (normalized.startsWith('UPDATE chat_idempotency SET status = ')) {
          if (
            normalized.includes("SET status = 'completed'") &&
            normalized.includes("status = 'delivered'")
          ) {
            const [, stuckBefore] = params as [string, Date];
            const staleRows = [...idempotencyStore.values()].filter(
              (row) =>
                row.status === 'delivered' && row.reservedAt < stuckBefore,
            );

            staleRows.forEach((row) => {
              row.status = 'completed';
            });

            return updateResult(
              staleRows.map((row) => ({
                idempotency_key: row.idempotencyKey,
              })),
            );
          }

          if (
            normalized.includes(
              "WHERE platform = $1 AND status = 'reserved' AND reserved_at < $2",
            )
          ) {
            const [, stuckBefore] = params as [string, Date];
            const staleRows = [...idempotencyStore.values()].filter(
              (row) =>
                row.status === 'reserved' && row.reservedAt < stuckBefore,
            );

            staleRows.forEach((row) => {
              row.status = 'refunded';
            });

            return updateResult(
              staleRows.map((row) => ({
                idempotency_key: row.idempotencyKey,
                external_user_id: row.externalUserId,
                user_id: row.userId,
                usage_date: row.usageDate,
                status: row.status,
                reserved_at: row.reservedAt,
              })),
            );
          }

          const [, idempotencyKey] = params as [string, string];
          const row = idempotencyStore.get(idempotencyKey);
          if (!row) {
            return updateResult([]);
          }

          if (normalized.includes("SET status = 'refunded'")) {
            if (row.status !== 'reserved') {
              return updateResult([]);
            }
            row.status = 'refunded';
            // The real statement returns the charge-owner snapshot, which the
            // repository uses to pick the bucket to decrement.
            return updateResult([
              {
                idempotency_key: idempotencyKey,
                external_user_id: row.externalUserId,
                usage_date: row.usageDate,
                user_id: row.userId,
              },
            ]);
          }

          if (normalized.includes("SET status = 'completed'")) {
            if (row.status !== 'reserved' && row.status !== 'delivered') {
              return updateResult([]);
            }
            row.status = 'completed';
            return updateResult([{ idempotency_key: idempotencyKey }]);
          }

          if (normalized.includes("SET status = 'delivered'")) {
            if (row.status !== 'reserved') {
              return updateResult([]);
            }
            row.status = 'delivered';
            return updateResult([{ idempotency_key: idempotencyKey }]);
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

        throw new Error(`Unexpected SQL in test: ${normalized}`);
      }),
      transaction: jest.fn(
        async <T>(work: (txManager: EntityManager) => Promise<T>) => {
          const releases: Array<() => void> = [];
          const query = manager.query as unknown as (
            sql: string,
            params: unknown[],
          ) => unknown[] | Promise<unknown[]>;
          let idempotencySnapshot: Map<string, IdempotencyRow> | undefined;
          let dailySnapshot: Map<string, DailyUsageRow> | undefined;
          const captureSnapshot = () => {
            if (idempotencySnapshot) {
              return;
            }
            idempotencySnapshot = new Map(idempotencyStore);
            dailySnapshot = new Map(dailyUsageStore);
          };
          const txManager = {
            ...manager,
            query: jest.fn(async (sql: string, params: unknown[]) => {
              const normalized = sql.replace(/\s+/g, ' ').trim();
              if (normalized.startsWith('SELECT pg_advisory_xact_lock')) {
                const release = await acquireAdvisoryLock(params[0] as string);
                releases.push(release);
                captureSnapshot();
                return [];
              }

              if (!serializeTransactions) {
                captureSnapshot();
              }
              return query(sql, params);
            }),
          } as unknown as EntityManager;

          const run = async () => {
            if (serializeTransactions) {
              captureSnapshot();
            }
            try {
              return await work(txManager);
            } catch (error) {
              idempotencyStore.clear();
              idempotencySnapshot?.forEach((value, key) =>
                idempotencyStore.set(key, value),
              );
              dailyUsageStore.clear();
              dailySnapshot?.forEach((value, key) =>
                dailyUsageStore.set(key, value),
              );
              throw error;
            } finally {
              releases.reverse().forEach((release) => release());
            }
          };

          if (!serializeTransactions) {
            return run();
          }

          const queued = transactionTail.then(run);
          transactionTail = queued.then(
            () => undefined,
            () => undefined,
          );
          return queued;
        },
      ),
    } as unknown as EntityManager;

    return manager;
  };

  beforeEach(() => {
    dailyUsageStore = new Map();
    idempotencyStore = new Map();
    serializeTransactions = true;
    recordedSql = [];

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
            userId?: { _type?: string };
          };
        }) => {
          if (where.userId?._type !== 'isNull') {
            throw new Error(
              'Unexpected findOne filter in test: expected userId IS NULL',
            );
          }

          const row = readUsage(where.externalUserId, where.usageDate, null);
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
      learnerUsageQuery,
    );
  });

  it('returns zero when no daily usage row exists', async () => {
    await expect(
      repository.getDailyUsageCount('ext-1', '2026-06-15'),
    ).resolves.toBe(0);
  });

  it("aggregates current-day usage across a learner's linked channels", async () => {
    seedUsage({
      externalUserId: 'ext-1',
      userId: 143,
      usageDate: '2026-06-15',
      freeFormCount: 2,
    });
    seedUsage({
      externalUserId: 'ext-2',
      userId: 143,
      usageDate: '2026-06-15',
      freeFormCount: 3,
    });

    await expect(
      repository.getDailyUsageCount('ext-1', '2026-06-15', 143),
    ).resolves.toBe(5);

    await expect(
      repository.reserveFreeFormSlotInTransaction(
        reserveInput({ idempotencyKey: 'mid-aggregate' }),
      ),
    ).resolves.toEqual({ status: 'reserved', freeFormCount: 6 });
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
      userId?: number;
      usageDate: string;
      dailyLimit: number;
      burstLimit?: number;
      burstSince?: Date;
      burstCountsRefunded?: boolean;
    }> = {},
  ) => ({
    idempotencyKey: 'mid-tx',
    externalUserId: 'ext-1',
    userId: 143,
    usageDate: '2026-06-15',
    dailyLimit: 15,
    burstLimit: undefined,
    burstSince: undefined,
    burstCountsRefunded: false,
    ...overrides,
  });

  it('reserves slot in one transaction with idempotency and usage increment', async () => {
    const outcome = await repository.reserveFreeFormSlotInTransaction(
      reserveInput({ idempotencyKey: 'mid-tx' }),
    );

    expect(outcome).toEqual({ status: 'reserved', freeFormCount: 1 });
    expect(idempotencyStore.get('mid-tx')?.status).toBe('reserved');
    await expect(
      repository.getDailyUsageCount('ext-1', '2026-06-15', 143),
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

  it('starts a separate anonymous bucket instead of rewriting a learner row', async () => {
    await repository.reserveFreeFormSlotInTransaction(
      reserveInput({ idempotencyKey: 'mid-linked' }),
    );

    const outcome = await repository.reserveFreeFormSlotInTransaction(
      reserveInput({ idempotencyKey: 'mid-anonymous', userId: undefined }),
    );

    expect(outcome).toEqual({ status: 'reserved', freeFormCount: 1 });
    expect(readUsage('ext-1', '2026-06-15', null)).toMatchObject({
      userId: null,
      freeFormCount: 1,
    });
    // The learner row keeps its owner and its count.
    expect(readUsage('ext-1', '2026-06-15', 143)).toMatchObject({
      userId: 143,
      freeFormCount: 1,
    });
  });

  it('starts a fresh anonymous bucket even when the learner row hit its cap', async () => {
    seedUsage({
      externalUserId: 'ext-1',
      userId: 143,
      usageDate: '2026-06-15',
      freeFormCount: 15,
    });

    await expect(
      repository.reserveFreeFormSlotInTransaction(
        reserveInput({
          idempotencyKey: 'mid-anonymous-cap',
          userId: undefined,
        }),
      ),
    ).resolves.toEqual({ status: 'reserved', freeFormCount: 1 });
    expect(readUsage('ext-1', '2026-06-15', null)).toMatchObject({
      userId: null,
      freeFormCount: 1,
    });
    expect(readUsage('ext-1', '2026-06-15', 143)?.freeFormCount).toBe(15);
  });

  it('denies the next linked turn after unlink -> anonymous -> relink churn', async () => {
    seedUsage({
      externalUserId: 'ext-1',
      userId: 143,
      usageDate: '2026-06-15',
      freeFormCount: 15,
    });

    // Unlinked: the anonymous turn charges its own bucket.
    await expect(
      repository.reserveFreeFormSlotInTransaction(
        reserveInput({ idempotencyKey: 'mid-churn-anon', userId: undefined }),
      ),
    ).resolves.toEqual({ status: 'reserved', freeFormCount: 1 });

    // Relinked: the learner bucket was never lowered, so the turn stays denied.
    await expect(
      repository.reserveFreeFormSlotInTransaction(
        reserveInput({ idempotencyKey: 'mid-churn-relink' }),
      ),
    ).resolves.toEqual({ status: 'daily_limit_exceeded' });

    await expect(
      repository.getDailyUsageCount('ext-1', '2026-06-15', 143),
    ).resolves.toBe(15);
    expect(readUsage('ext-1', '2026-06-15', null)?.freeFormCount).toBe(1);
  });

  it('preserves both buckets across repeated churn in one usage date', async () => {
    seedUsage({
      externalUserId: 'ext-1',
      userId: 143,
      usageDate: '2026-06-15',
      freeFormCount: 5,
    });

    for (let cycle = 0; cycle < 3; cycle += 1) {
      await expect(
        repository.reserveFreeFormSlotInTransaction(
          reserveInput({
            idempotencyKey: `mid-churn-anon-${cycle}`,
            userId: undefined,
          }),
        ),
      ).resolves.toEqual({ status: 'reserved', freeFormCount: cycle + 1 });

      await expect(
        repository.reserveFreeFormSlotInTransaction(
          reserveInput({ idempotencyKey: `mid-churn-linked-${cycle}` }),
        ),
      ).resolves.toEqual({ status: 'reserved', freeFormCount: 6 + cycle });
    }

    expect(readUsage('ext-1', '2026-06-15', 143)?.freeFormCount).toBe(8);
    expect(readUsage('ext-1', '2026-06-15', null)?.freeFormCount).toBe(3);
  });

  it('does not adopt anonymous usage into the learner bucket when the channel links', async () => {
    await expect(
      repository.reserveFreeFormSlotInTransaction(
        reserveInput({ idempotencyKey: 'mid-anon-first', userId: undefined }),
      ),
    ).resolves.toEqual({ status: 'reserved', freeFormCount: 1 });

    await expect(
      repository.reserveFreeFormSlotInTransaction(
        reserveInput({ idempotencyKey: 'mid-linked-second' }),
      ),
    ).resolves.toEqual({ status: 'reserved', freeFormCount: 1 });

    await expect(
      repository.getDailyUsageCount('ext-1', '2026-06-15', 143),
    ).resolves.toBe(1);
    await expect(
      repository.getDailyUsageCount('ext-1', '2026-06-15'),
    ).resolves.toBe(1);
    expect(readUsage('ext-1', '2026-06-15', 143)?.freeFormCount).toBe(1);
    expect(readUsage('ext-1', '2026-06-15', null)?.freeFormCount).toBe(1);
  });

  it('reuses the learner bucket when the same learner relinks', async () => {
    await repository.reserveFreeFormSlotInTransaction(
      reserveInput({ idempotencyKey: 'mid-relink-first' }),
    );
    await repository.reserveFreeFormSlotInTransaction(
      reserveInput({ idempotencyKey: 'mid-relink-second' }),
    );

    expect(readUsage('ext-1', '2026-06-15', 143)?.freeFormCount).toBe(2);
    expect(dailyUsageStore.size).toBe(1);
  });

  it('keeps usage with the learner that was charged when the channel relinks to another learner', async () => {
    await expect(
      repository.reserveFreeFormSlotInTransaction(
        reserveInput({ idempotencyKey: 'mid-user-a' }),
      ),
    ).resolves.toEqual({ status: 'reserved', freeFormCount: 1 });

    await expect(
      repository.reserveFreeFormSlotInTransaction(
        reserveInput({ idempotencyKey: 'mid-user-b', userId: 299 }),
      ),
    ).resolves.toEqual({ status: 'reserved', freeFormCount: 1 });

    expect(readUsage('ext-1', '2026-06-15', 143)?.freeFormCount).toBe(1);
    expect(readUsage('ext-1', '2026-06-15', 299)?.freeFormCount).toBe(1);
    await expect(
      repository.getDailyUsageCount('ext-1', '2026-06-15', 143),
    ).resolves.toBe(1);
    await expect(
      repository.getDailyUsageCount('ext-1', '2026-06-15', 299),
    ).resolves.toBe(1);
  });

  it('enforces one learner cap across platforms under concurrency', async () => {
    serializeTransactions = false;
    seedUsage({
      externalUserId: 'ext-discord',
      userId: 143,
      usageDate: '2026-06-15',
      freeFormCount: 14,
    });

    const outcomes = await Promise.all([
      repository.reserveFreeFormSlotInTransaction(
        reserveInput({ idempotencyKey: 'mid-cross-messenger', dailyLimit: 15 }),
      ),
      repository.reserveFreeFormSlotInTransaction(
        reserveInput({
          idempotencyKey: 'mid-cross-discord',
          externalUserId: 'ext-discord',
          dailyLimit: 15,
        }),
      ),
    ]);

    expect(outcomes.filter((item) => item.status === 'reserved')).toHaveLength(
      1,
    );
    expect(
      outcomes.filter((item) => item.status === 'daily_limit_exceeded'),
    ).toHaveLength(1);
    await expect(
      repository.getDailyUsageCount('ext-1', '2026-06-15', 143),
    ).resolves.toBe(15);
  });

  it('refunds the bucket that was charged after the channel links', async () => {
    await repository.reserveFreeFormSlotInTransaction(
      reserveInput({ idempotencyKey: 'mid-anon-refund', userId: undefined }),
    );
    await repository.reserveFreeFormSlotInTransaction(
      reserveInput({ idempotencyKey: 'mid-linked-after-refund' }),
    );

    await expect(
      repository.refundReservedSlot({
        idempotencyKey: 'mid-anon-refund',
        externalUserId: 'ext-1',
        usageDate: '2026-06-15',
      }),
    ).resolves.toBe(true);

    expect(readUsage('ext-1', '2026-06-15', null)?.freeFormCount).toBe(0);
    expect(readUsage('ext-1', '2026-06-15', 143)?.freeFormCount).toBe(1);
  });

  it('recovers a stuck reservation in its original bucket after the channel links', async () => {
    idempotencyStore.set('mid-anon-stuck', {
      idempotencyKey: 'mid-anon-stuck',
      externalUserId: 'ext-1',
      userId: null,
      usageDate: '2026-06-15',
      status: 'reserved',
      reservedAt: new Date('2026-06-15T07:00:00+07:00'),
    });
    seedUsage({
      externalUserId: 'ext-1',
      userId: null,
      usageDate: '2026-06-15',
      freeFormCount: 1,
    });
    seedUsage({
      externalUserId: 'ext-1',
      userId: 143,
      usageDate: '2026-06-15',
      freeFormCount: 1,
    });

    await expect(
      repository.recoverAllStuckReserved(new Date('2026-06-15T08:00:00+07:00')),
    ).resolves.toEqual(['mid-anon-stuck']);

    expect(readUsage('ext-1', '2026-06-15', null)?.freeFormCount).toBe(0);
    expect(readUsage('ext-1', '2026-06-15', 143)?.freeFormCount).toBe(1);
  });

  it('keeps burst protection channel-scoped across a link transition', async () => {
    const burstSince = new Date('2026-06-14T08:00:00+07:00');

    await expect(
      repository.reserveFreeFormSlotInTransaction(
        reserveInput({
          idempotencyKey: 'mid-burst-anon',
          userId: undefined,
          burstLimit: 1,
          burstSince,
        }),
      ),
    ).resolves.toEqual({ status: 'reserved', freeFormCount: 1 });

    await expect(
      repository.reserveFreeFormSlotInTransaction(
        reserveInput({
          idempotencyKey: 'mid-burst-linked',
          burstLimit: 1,
          burstSince,
        }),
      ),
    ).resolves.toEqual({ status: 'burst_limit_exceeded', count: 2 });
  });

  // Schema-contract guard: the in-memory driver below cannot observe a missing
  // Postgres conflict target, so the two statements must keep naming the
  // owner-aware partial indexes from the #1177 migration. Every other guarantee
  // in this file is asserted through observable bucket outcomes.
  it('names the owner-aware partial indexes as its conflict targets', async () => {
    await repository.reserveFreeFormSlotInTransaction(
      reserveInput({ idempotencyKey: 'mid-sql-linked' }),
    );
    await repository.reserveFreeFormSlotInTransaction(
      reserveInput({ idempotencyKey: 'mid-sql-anon', userId: undefined }),
    );

    const inserts = recordedSql.filter((sql) =>
      sql.startsWith('INSERT INTO chat_daily_usage'),
    );

    expect(inserts).toHaveLength(2);
    expect(inserts[0]).toContain(
      'ON CONFLICT (platform, external_user_id, usage_date, user_id) WHERE user_id IS NOT NULL',
    );
    expect(inserts[1]).toContain(
      'ON CONFLICT (platform, external_user_id, usage_date) WHERE user_id IS NULL',
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
      repository.getDailyUsageCount('ext-1', '2026-06-15', 143),
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
      repository.getDailyUsageCount('ext-1', '2026-06-15', 143),
    ).resolves.toBe(0);
    expect(hooks.onReleased).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        externalUserId: 'ext-1',
        userId: 143,
        idempotencyKey: 'mid-refund',
        reason: 'send_failed',
        usedAfter: 0,
      }),
    );
  });

  it('refunds a linked reservation into the learner bucket after the channel unlinks', async () => {
    await repository.reserveFreeFormSlotInTransaction(
      reserveInput({ idempotencyKey: 'mid-linked-refund' }),
    );
    // Unlinked afterwards: the anonymous turn opens its own bucket.
    await repository.reserveFreeFormSlotInTransaction(
      reserveInput({
        idempotencyKey: 'mid-anon-after-unlink',
        userId: undefined,
      }),
    );

    await expect(
      repository.refundReservedSlot({
        idempotencyKey: 'mid-linked-refund',
        externalUserId: 'ext-1',
        usageDate: '2026-06-15',
      }),
    ).resolves.toBe(true);

    expect(readUsage('ext-1', '2026-06-15', 143)?.freeFormCount).toBe(0);
    expect(readUsage('ext-1', '2026-06-15', null)?.freeFormCount).toBe(1);
    expect(hooks.onReleased).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: 143, usedAfter: 0 }),
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
      repository.getDailyUsageCount('ext-1', '2026-06-15', 143),
    ).resolves.toBe(1);
  });

  it('marks delivered idempotency before finalization', async () => {
    await repository.reserveFreeFormSlotInTransaction(
      reserveInput({ idempotencyKey: 'mid-delivered' }),
    );

    const delivered = await repository.markDeliveredSlot('mid-delivered');

    expect(delivered).toBe(true);
    expect(idempotencyStore.get('mid-delivered')?.status).toBe('delivered');
    expect(await repository.completeReservedSlot('mid-delivered')).toBe(true);
    expect(idempotencyStore.get('mid-delivered')?.status).toBe('completed');
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

  it('recovers stale rows when TypeORM wraps UPDATE results', async () => {
    const staleAt = new Date('2026-06-15T07:00:00+07:00');
    idempotencyStore.set('mid-stuck-bulk', {
      idempotencyKey: 'mid-stuck-bulk',
      externalUserId: 'ext-1',
      userId: null,
      usageDate: '2026-06-15',
      status: 'reserved',
      reservedAt: staleAt,
    });
    seedUsage({
      externalUserId: 'ext-1',
      userId: null,
      usageDate: '2026-06-15',
      freeFormCount: 1,
    });

    await expect(
      repository.recoverAllStuckReserved(new Date('2026-06-15T08:00:00+07:00')),
    ).resolves.toEqual(['mid-stuck-bulk']);

    expect(idempotencyStore.get('mid-stuck-bulk')?.status).toBe('refunded');
    expect(readUsage('ext-1', '2026-06-15', null)?.freeFormCount).toBe(0);
  });

  it('refunds exactly one logical user counter when external users share a null user_id', async () => {
    const staleAt = new Date('2026-06-15T07:00:00+07:00');
    idempotencyStore.set('mid-stuck-external', {
      idempotencyKey: 'mid-stuck-external',
      externalUserId: 'ext-1',
      userId: null,
      usageDate: '2026-06-15',
      status: 'reserved',
      reservedAt: staleAt,
    });
    seedUsage({
      externalUserId: 'ext-1',
      userId: null,
      usageDate: '2026-06-15',
      freeFormCount: 1,
    });
    seedUsage({
      externalUserId: 'ext-2',
      userId: null,
      usageDate: '2026-06-15',
      freeFormCount: 1,
    });

    await expect(
      repository.recoverAllStuckReserved(new Date('2026-06-15T08:00:00+07:00')),
    ).resolves.toEqual(['mid-stuck-external']);

    expect(readUsage('ext-1', '2026-06-15', null)?.freeFormCount).toBe(0);
    expect(readUsage('ext-2', '2026-06-15', null)?.freeFormCount).toBe(1);
  });

  it('is idempotent when recovery is rerun (no double decrement)', async () => {
    const staleAt = new Date('2026-06-15T07:00:00+07:00');
    idempotencyStore.set('mid-rerun', {
      idempotencyKey: 'mid-rerun',
      externalUserId: 'ext-1',
      userId: null,
      usageDate: '2026-06-15',
      status: 'reserved',
      reservedAt: staleAt,
    });
    seedUsage({
      externalUserId: 'ext-1',
      userId: null,
      usageDate: '2026-06-15',
      freeFormCount: 1,
    });

    const first = await repository.recoverAllStuckReserved(
      new Date('2026-06-15T08:00:00+07:00'),
    );
    // Rerun: rows were already flipped to 'refunded' in the same transaction —
    // nothing is re-selected and the counter is NOT decremented again.
    const second = await repository.recoverAllStuckReserved(
      new Date('2026-06-15T08:00:00+07:00'),
    );

    expect(first).toEqual(['mid-rerun']);
    expect(second).toEqual([]);
    expect(readUsage('ext-1', '2026-06-15', null)?.freeFormCount).toBe(0);
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
    seedUsage({
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
      repository.getDailyUsageCount('ext-1', '2026-06-15', 143),
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

  it('does not reopen delivered idempotency on duplicate retry', async () => {
    idempotencyStore.set('mid-delivered-retry', {
      idempotencyKey: 'mid-delivered-retry',
      externalUserId: 'ext-1',
      userId: null,
      usageDate: '2026-06-15',
      status: 'delivered',
      reservedAt: new Date('2026-06-15T07:00:00+07:00'),
    });

    await expect(
      repository.recoverIdempotencyForRetry(
        'mid-delivered-retry',
        new Date('2026-06-15T08:00:00+07:00'),
      ),
    ).resolves.toBe('delivered');
    expect(idempotencyStore.get('mid-delivered-retry')?.status).toBe(
      'delivered',
    );
  });

  it('finalizes stale delivered rows without decrementing usage', async () => {
    idempotencyStore.set('mid-stale-delivered', {
      idempotencyKey: 'mid-stale-delivered',
      externalUserId: 'ext-1',
      userId: null,
      usageDate: '2026-06-15',
      status: 'delivered',
      reservedAt: new Date('2026-06-15T07:00:00+07:00'),
    });
    seedUsage({
      externalUserId: 'ext-1',
      userId: null,
      usageDate: '2026-06-15',
      freeFormCount: 1,
    });

    await expect(
      repository.recoverAllStuckReserved(new Date('2026-06-15T08:00:00+07:00')),
    ).resolves.toEqual(['mid-stale-delivered']);

    expect(idempotencyStore.get('mid-stale-delivered')?.status).toBe(
      'completed',
    );
    expect(readUsage('ext-1', '2026-06-15', null)?.freeFormCount).toBe(1);
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
    seedUsage({
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
    seedUsage({
      externalUserId: 'ext-1',
      userId: 143,
      usageDate: '2026-06-15',
      freeFormCount: 15,
    });

    const outcome = await repository.reserveFreeFormSlotInTransaction(
      reserveInput({ idempotencyKey: 'mid-cap', dailyLimit: 15 }),
    );

    expect(outcome).toEqual({ status: 'daily_limit_exceeded' });
    expect(idempotencyStore.has('mid-cap')).toBe(false);
    await expect(
      repository.getDailyUsageCount('ext-1', '2026-06-15', 143),
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

  it('applies the refunded-row burst policy inside the reserve transaction', async () => {
    idempotencyStore.set('mid-refunded', {
      idempotencyKey: 'mid-refunded',
      externalUserId: 'ext-1',
      userId: null,
      usageDate: '2026-06-15',
      status: 'refunded',
      reservedAt: new Date('2026-06-15T08:00:00+07:00'),
    });

    const outcome = await repository.reserveFreeFormSlotInTransaction(
      reserveInput({
        idempotencyKey: 'mid-burst-refunded',
        burstLimit: 1,
        burstSince: new Date('2026-06-14T08:00:00+07:00'),
        burstCountsRefunded: true,
      }),
    );

    expect(outcome).toEqual({ status: 'burst_limit_exceeded', count: 2 });
    expect(idempotencyStore.has('mid-burst-refunded')).toBe(false);
  });

  it('admits only one concurrent reserve at the burst limit', async () => {
    serializeTransactions = false;
    const burstSince = new Date('2026-06-14T08:00:00+07:00');
    const [first, second] = await Promise.all([
      repository.reserveFreeFormSlotInTransaction(
        reserveInput({
          idempotencyKey: 'mid-concurrent-a',
          burstLimit: 1,
          burstSince,
        }),
      ),
      repository.reserveFreeFormSlotInTransaction(
        reserveInput({
          idempotencyKey: 'mid-concurrent-b',
          burstLimit: 1,
          burstSince,
        }),
      ),
    ]);

    const outcomes = [first, second];
    expect(outcomes.filter((item) => item.status === 'reserved')).toHaveLength(
      1,
    );
    expect(
      outcomes.filter((item) => item.status === 'burst_limit_exceeded'),
    ).toHaveLength(1);
    expect(idempotencyStore.size).toBe(1);
    await expect(
      repository.getDailyUsageCount('ext-1', '2026-06-15', 143),
    ).resolves.toBe(1);
  });

  it('allows only one concurrent reserve when at daily limit minus one', async () => {
    seedUsage({
      externalUserId: 'ext-1',
      userId: 143,
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
      repository.getDailyUsageCount('ext-1', '2026-06-15', 143),
    ).resolves.toBe(15);
  });

  it('lists bounded fixed-bucket counts for the Redis audit', async () => {
    idempotencyStore.set('key-a', {
      idempotencyKey: 'key-a',
      externalUserId: 'ext-a',
      userId: null,
      usageDate: '2026-06-15',
      status: 'reserved',
      reservedAt: new Date('2026-06-15T01:00:00Z'),
    });
    idempotencyStore.set('key-b', {
      idempotencyKey: 'key-b',
      externalUserId: 'ext-a',
      userId: null,
      usageDate: '2026-06-15',
      status: 'completed',
      reservedAt: new Date('2026-06-15T01:00:30Z'),
    });

    await expect(
      repository.listBurstCountsForBucket(
        new Date('2026-06-15T01:00:00Z'),
        new Date('2026-06-15T01:01:00Z'),
        { limit: 1 },
      ),
    ).resolves.toEqual({
      rows: [{ externalUserId: 'ext-a', count: 2 }],
      truncated: false,
    });
  });

  it('lists refunded-only users with a zero authoritative count', async () => {
    idempotencyStore.set('refunded-key', {
      idempotencyKey: 'refunded-key',
      externalUserId: 'refunded-user',
      userId: null,
      usageDate: '2026-06-15',
      status: 'refunded',
      reservedAt: new Date('2026-06-15T01:00:00Z'),
    });

    await expect(
      repository.listBurstCountsForBucket(
        new Date('2026-06-15T01:00:00Z'),
        new Date('2026-06-15T01:01:00Z'),
      ),
    ).resolves.toEqual({
      rows: [{ externalUserId: 'refunded-user', count: 0 }],
      truncated: false,
    });
  });
});
