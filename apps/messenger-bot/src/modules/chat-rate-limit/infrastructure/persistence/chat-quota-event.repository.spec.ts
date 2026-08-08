import { ChatQuotaEventRepository } from './chat-quota-event.repository';

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
    it('calls query with correct SQL and params', async () => {
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
          'psid-1',
          JSON.stringify({ used: 5, limit: 15, reason: 'CHAT' }),
          '2026-08-08',
          42,
          'idem-1',
        ],
      );
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
    it('calls query with CHAT_QUOTA_RELEASED event type', async () => {
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
          'psid-1',
          JSON.stringify({ used: 4, limit: 15 }),
          '2026-08-08',
          null,
          'idem-r1',
        ],
      );
    });
  });

  describe('insertDenied', () => {
    it('calls query with CHAT_QUOTA_DENIED and null idempotency_key', async () => {
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
          'psid-3',
          JSON.stringify({ used: 15, limit: 15, reason: 'DAILY_LIMIT' }),
          '2026-08-08',
          99,
        ],
      );
    });
  });

  describe('deleteOlderThan', () => {
    it('returns count of deleted rows', async () => {
      queryFn.mockResolvedValue([{ count: '5' }]);

      const result = await repo.deleteOlderThan(new Date('2026-01-01'));

      expect(result).toBe(5);
      expect(queryFn).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM chat_quota_events'),
        [new Date('2026-01-01')],
      );
    });

    it('returns 0 when no rows deleted', async () => {
      queryFn.mockResolvedValue([{ count: '0' }]);

      const result = await repo.deleteOlderThan(new Date('2026-08-08'));

      expect(result).toBe(0);
    });
  });
});
