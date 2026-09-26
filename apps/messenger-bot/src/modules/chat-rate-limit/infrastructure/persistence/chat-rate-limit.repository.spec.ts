import { EntityManager, Repository } from 'typeorm';
import {
  ChatDailyUsageEntity,
  ChatIdempotencyEntity,
} from '@wispace/chat-metering/adapters';
import { ChatRateLimitRepository } from './chat-rate-limit.repository';
import type { ChatQuotaEventRecorderService } from '../../application/services/chat-quota-event-recorder.service';

type DailyUsageRow = {
  psid: string;
  userId: number | null;
  usageDate: string;
  freeFormCount: number;
};

type IdempotencyRow = {
  idempotencyKey: string;
  psid: string;
  userId: number | null;
  usageDate: string;
  status: 'reserved' | 'delivered' | 'completed' | 'refunded';
  reservedAt: Date;
};

describe('ChatRateLimitRepository (messenger-bot wrapper)', () => {
  let repository: ChatRateLimitRepository;
  let dailyUsageStore: Map<string, DailyUsageRow>;
  let idempotencyStore: Map<string, IdempotencyRow>;
  let quotaEventRecorder: jest.Mocked<
    Pick<
      ChatQuotaEventRecorderService,
      'recordReservedInTransaction' | 'recordReleasedInTransaction'
    >
  >;

  // Owner-aware key: a learner row and an anonymous row for the same channel
  // and date are distinct rows (#1177).
  const usageKey = (psid: string, usageDate: string, userId?: number | null) =>
    `${psid}:${usageDate}:${userId ?? 'anonymous'}`;

  const createManager = (): EntityManager => {
    const manager = {
      query: jest.fn((sql: string, params: unknown[]) => {
        const normalized = sql.replace(/\s+/g, ' ').trim();

        if (
          normalized === 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))'
        ) {
          return [];
        }

        if (normalized.includes('FROM pg_indexes')) {
          return [
            {
              legacy_index: false,
              linked_index: true,
              anonymous_index: true,
            },
          ];
        }

        if (normalized.includes('COALESCE(SUM(')) {
          const [usageDate, userId] = params as [string, number];
          // Learner bucket only — anonymous rows are never adopted (#1177).
          const used = [...dailyUsageStore.values()]
            .filter(
              (row) => row.usageDate === usageDate && row.userId === userId,
            )
            .reduce((total, row) => total + row.freeFormCount, 0);
          return [{ used }];
        }

        if (
          normalized.startsWith(
            'INSERT INTO chat_daily_usage (platform, external_user_id, user_id, usage_date, free_form_count)',
          )
        ) {
          const psid = params[1] as string;
          const userId = params[2] as number | null;
          const usageDate = params[3] as string;
          const dailyLimit = params[4] as number | undefined;
          const targetsAnonymousRow = normalized.includes(
            'WHERE user_id IS NULL',
          );
          const key = usageKey(psid, usageDate, userId);
          const existing = dailyUsageStore.get(key);

          if (!existing) {
            dailyUsageStore.set(key, {
              psid,
              userId,
              usageDate,
              freeFormCount: 1,
            });
            return [{ free_form_count: 1 }];
          }

          // Only the anonymous upsert carries the hard cap; the linked path is
          // capped by the learner/date lock taken before the write.
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
          const [, psid, usageDate, ownerUserId] = params as [
            string,
            string,
            string,
            number | undefined,
          ];
          const existing = dailyUsageStore.get(
            usageKey(
              psid,
              usageDate,
              normalized.includes('user_id IS NULL') ? null : ownerUserId,
            ),
          );
          if (!existing) {
            return [];
          }

          existing.freeFormCount = Math.max(existing.freeFormCount - 1, 0);
          return [{ free_form_count: existing.freeFormCount }];
        }

        if (
          normalized.startsWith(
            'INSERT INTO chat_idempotency ( idempotency_key, platform, external_user_id, user_id, usage_date, status )',
          )
        ) {
          const [idempotencyKey, , psid, userId, usageDate] = params as [
            string,
            string,
            string,
            number | null,
            string,
          ];

          if (idempotencyStore.has(idempotencyKey)) {
            return [];
          }

          const row: IdempotencyRow = {
            idempotencyKey,
            psid,
            userId,
            usageDate,
            status: 'reserved',
            reservedAt: new Date('2026-06-15T08:00:00+07:00'),
          };
          idempotencyStore.set(idempotencyKey, row);

          return [
            {
              idempotency_key: row.idempotencyKey,
              external_user_id: row.psid,
              user_id: row.userId,
              usage_date: row.usageDate,
              status: row.status,
              reserved_at: row.reservedAt,
            },
          ];
        }

        throw new Error(`Unexpected SQL in test: ${normalized}`);
      }),
      transaction: jest.fn(
        async <T>(work: (txManager: EntityManager) => Promise<T>) =>
          work(manager),
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
            userId?: { _type?: string };
          };
        }) => {
          if (where.userId?._type !== 'isNull') {
            throw new Error(
              'Unexpected findOne filter in test: expected userId IS NULL',
            );
          }

          const row = dailyUsageStore.get(
            usageKey(where.externalUserId, where.usageDate, null),
          );
          if (!row) {
            return Promise.resolve(null);
          }
          return Promise.resolve({ freeFormCount: row.freeFormCount });
        },
      ),
      createQueryBuilder: jest.fn(() => {
        const qb: {
          select: () => typeof qb;
          addSelect: () => typeof qb;
          from: () => typeof qb;
          where: () => typeof qb;
          andWhere: () => typeof qb;
          groupBy: () => typeof qb;
          setParameter: () => typeof qb;
          getRawOne: () => Promise<{ count: number }>;
        } = {
          select: jest.fn(() => qb),
          addSelect: jest.fn(() => qb),
          from: jest.fn(() => qb),
          where: jest.fn(() => qb),
          andWhere: jest.fn(() => qb),
          groupBy: jest.fn(() => qb),
          setParameter: jest.fn(() => qb),
          getRawOne: jest.fn(() => Promise.resolve({ count: 0 })),
        };
        return qb;
      }),
      manager,
    } as unknown as Repository<ChatDailyUsageEntity>;

    const idempotencyRepo = {
      findOne: jest.fn(({ where }: { where: { idempotencyKey: string } }) => {
        const row = idempotencyStore.get(where.idempotencyKey);
        if (!row) {
          return Promise.resolve(null);
        }
        return Promise.resolve({
          idempotencyKey: row.idempotencyKey,
          externalUserId: row.psid,
          userId: row.userId,
          usageDate: row.usageDate,
          status: row.status,
          reservedAt: row.reservedAt,
        });
      }),
      update: jest.fn(
        (
          where: { idempotencyKey: string },
          patch: { status: IdempotencyRow['status'] },
        ) => {
          const row = idempotencyStore.get(where.idempotencyKey);
          if (!row) {
            return Promise.resolve({ affected: 0 });
          }
          row.status = patch.status;
          return Promise.resolve({ affected: 1 });
        },
      ),
      createQueryBuilder: jest.fn(() => {
        const qb: {
          where: () => typeof qb;
          andWhere: () => typeof qb;
          select: () => typeof qb;
          addSelect: () => typeof qb;
          groupBy: () => typeof qb;
          getCount: () => Promise<number>;
          getRawMany: () => Promise<unknown[]>;
        } = {
          where: jest.fn(() => qb),
          andWhere: jest.fn(() => qb),
          select: jest.fn(() => qb),
          addSelect: jest.fn(() => qb),
          groupBy: jest.fn(() => qb),
          getCount: jest.fn(() => Promise.resolve(0)),
          getRawMany: jest.fn(() => Promise.resolve([])),
        };
        return qb;
      }),
      manager,
    } as unknown as Repository<ChatIdempotencyEntity>;

    quotaEventRecorder = {
      recordReservedInTransaction: jest.fn(() => Promise.resolve()),
      recordReleasedInTransaction: jest.fn(() => Promise.resolve()),
    } as unknown as typeof quotaEventRecorder;

    repository = new ChatRateLimitRepository(
      dailyUsageRepo,
      idempotencyRepo,
      quotaEventRecorder as unknown as ChatQuotaEventRecorderService,
    );
  });

  it('reserves via the shared chat-metering core and records the quota event', async () => {
    const outcome = await repository.reserveFreeFormSlotInTransaction({
      idempotencyKey: 'mid-1',
      psid: 'psid-1',
      userId: 143,
      usageDate: '2026-06-15',
      dailyLimit: 15,
    });

    expect(outcome).toEqual({ status: 'reserved', freeFormCount: 1 });
    expect(quotaEventRecorder.recordReservedInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ psid: 'psid-1', idempotencyKey: 'mid-1' }),
    );
  });

  it('exposes ops-only aggregate counters without throwing', async () => {
    await expect(repository.countStuckReserved(new Date())).resolves.toBe(0);
    await expect(
      repository.countIdempotencyByStatusForUsageDate('2026-06-15'),
    ).resolves.toEqual({});
    await expect(
      repository.countUsersAtOrAboveDailyLimit('2026-06-15', 15),
    ).resolves.toBe(0);
  });
});
