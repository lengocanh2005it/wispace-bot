import { createHash } from 'crypto';
import { ChatQuotaEventRepository } from './chat-quota-event.repository';

const sha256 = (id: string) =>
  createHash('sha256').update(id, 'utf8').digest('hex');

describe('ChatQuotaEventRepository', () => {
  let repo: ChatQuotaEventRepository;
  let queryFn: jest.Mock;

  beforeEach(() => {
    queryFn = jest.fn();
    repo = new ChatQuotaEventRepository({
      manager: { query: queryFn },
    } as never);
  });

  describe('insertReservedInTransaction', () => {
    it('calls query with correct SQL and params (aggregate_id hashed)', async () => {
      const manager = { query: jest.fn() };
      await repo.insertReservedInTransaction(manager, {
        psid: 'psid-1',
        usageDate: '2026-08-08',
        userId: 42,
        idempotencyKey: 'idem-1',
        payload: { used: 5, limit: 15, reason: 'CHAT' },
      });

      expect(manager.query).toHaveBeenCalledWith(
        expect.stringContaining('CHAT_QUOTA_RESERVED'),
        [
          'messenger',
          sha256('42'),
          JSON.stringify({ used: 5, limit: 15, reason: 'CHAT' }),
          '2026-08-08',
          42,
          'idem-1',
        ],
      );
    });

    it('never persists the raw psid', async () => {
      const manager = { query: jest.fn() };
      await repo.insertReservedInTransaction(manager, {
        psid: 'psid-1',
        usageDate: '2026-08-08',
        idempotencyKey: 'idem-1',
        payload: { used: 1, limit: 15 },
      });

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const params: unknown[] = manager.query.mock.calls[0]![1] as unknown[];
      expect(params[1]).not.toBe('psid-1');
      expect(params[1]).toMatch(/^[0-9a-f]{64}$/);
    });

    it('passes null for userId when undefined', async () => {
      const manager = { query: jest.fn() };
      await repo.insertReservedInTransaction(manager, {
        psid: 'psid-2',
        usageDate: '2026-08-08',
        idempotencyKey: 'idem-2',
        payload: { used: 1, limit: 15 },
      });

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const params: unknown[] = manager.query.mock.calls[0]![1] as unknown[];
      expect(params[4]).toBeNull();
    });
  });

  describe('insertReleasedInTransaction', () => {
    it('calls query with CHAT_QUOTA_RELEASED event type (aggregate_id hashed)', async () => {
      const manager = { query: jest.fn() };
      await repo.insertReleasedInTransaction(manager, {
        psid: 'psid-1',
        usageDate: '2026-08-08',
        idempotencyKey: 'idem-r1',
        payload: { used: 4, limit: 15 },
      });

      expect(manager.query).toHaveBeenCalledWith(
        expect.stringContaining('CHAT_QUOTA_RELEASED'),
        [
          'messenger',
          sha256('psid-1'),
          JSON.stringify({ used: 4, limit: 15 }),
          '2026-08-08',
          null,
          'idem-r1',
        ],
      );
    });
  });

  describe('insertDenied', () => {
    it('calls query with CHAT_QUOTA_DENIED and null idempotency_key (aggregate_id hashed)', async () => {
      await repo.insertDenied({
        psid: 'psid-3',
        usageDate: '2026-08-08',
        userId: 99,
        payload: { used: 15, limit: 15, reason: 'DAILY_LIMIT' },
      });

      expect(queryFn).toHaveBeenCalledWith(
        expect.stringContaining('CHAT_QUOTA_DENIED'),
        [
          'messenger',
          sha256('99'),
          JSON.stringify({ used: 15, limit: 15, reason: 'DAILY_LIMIT' }),
          '2026-08-08',
          99,
        ],
      );
    });
  });

  describe('deleteOlderThan', () => {
    it('deletes in batches of 1000 until exhausted (multi-batch backlog)', async () => {
      queryFn
        .mockResolvedValueOnce([
          Array.from({ length: 1000 }, (_, i) => ({ id: String(i) })),
          1000,
        ])
        .mockResolvedValueOnce([
          Array.from({ length: 1000 }, (_, i) => ({ id: String(i + 1000) })),
          1000,
        ])
        .mockResolvedValueOnce([
          Array.from({ length: 200 }, (_, i) => ({ id: String(i + 2000) })),
          200,
        ]);

      const result = await repo.deleteOlderThan(new Date('2026-01-01'));

      expect(result).toBe(2200);
      // 3 calls: 2 full batches + 1 partial batch (loop exits because < 1000)
      expect(queryFn).toHaveBeenCalledTimes(3);
      expect(queryFn).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM chat_quota_events'),
        [new Date('2026-01-01'), 1000],
      );
    });

    it('returns 0 when no rows match (real [[], 0] tuple shape, empty backlog)', async () => {
      queryFn.mockResolvedValueOnce([[], 0]);

      const result = await repo.deleteOlderThan(new Date('2026-08-08'));

      expect(result).toBe(0);
      expect(queryFn).toHaveBeenCalledTimes(1);
    });

    it('handles exactly-full batch (1000 rows) then empty', async () => {
      queryFn
        .mockResolvedValueOnce([
          Array.from({ length: 1000 }, (_, i) => ({ id: String(i) })),
          1000,
        ])
        .mockResolvedValueOnce([[], 0]);

      const result = await repo.deleteOlderThan(new Date('2026-01-01'));

      expect(result).toBe(1000);
      // Exactly-full batch triggers a second call to check for more
      expect(queryFn).toHaveBeenCalledTimes(2);
    });

    it('stops after a partial batch', async () => {
      queryFn.mockResolvedValueOnce([
        Array.from({ length: 50 }, (_, i) => ({ id: String(i) })),
        50,
      ]);

      const result = await repo.deleteOlderThan(new Date('2026-01-01'));

      expect(result).toBe(50);
      expect(queryFn).toHaveBeenCalledTimes(1);
    });

    it('propagates error on batch failure (retry resumes from next cron tick)', async () => {
      queryFn
        .mockRejectedValueOnce(new Error('connection timeout'))
        .mockResolvedValueOnce([
          Array.from({ length: 300 }, (_, i) => ({ id: String(i) })),
          300,
        ]);

      // First call fails on first batch
      await expect(
        repo.deleteOlderThan(new Date('2026-01-01')),
      ).rejects.toThrow('connection timeout');

      // Second call (simulating next cron tick) picks up remaining rows
      const result = await repo.deleteOlderThan(new Date('2026-01-01'));
      expect(result).toBe(300);
    });
  });
});
