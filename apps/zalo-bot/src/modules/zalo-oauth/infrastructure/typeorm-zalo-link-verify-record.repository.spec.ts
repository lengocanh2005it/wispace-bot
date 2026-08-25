import { TypeormZaloLinkVerifyRecordRepository } from './typeorm-zalo-link-verify-record.repository';

function mockRepo() {
  return {
    find: jest.fn().mockResolvedValue([]),
    create: jest.fn(),
    save: jest.fn(),
    upsert: jest.fn(),
    delete: jest.fn(),
    findOne: jest.fn(),
  };
}

describe('TypeormZaloLinkVerifyRecordRepository', () => {
  describe('listStaleRecords', () => {
    it('selects records older than cutoff (LessThan)', async () => {
      const repo = mockRepo();
      const repository = new TypeormZaloLinkVerifyRecordRepository(
        repo as never,
      );

      await repository.listStaleRecords(120_000);

      const call = repo.find.mock.calls[0][0];
      expect(call.where.verifiedAt._type).toBe('lessThan');
    });

    it('returns empty when all records are fresh', async () => {
      const repo = mockRepo();
      repo.find.mockResolvedValue([]);
      const repository = new TypeormZaloLinkVerifyRecordRepository(
        repo as never,
      );

      const result = await repository.listStaleRecords(120_000);
      expect(result).toEqual([]);
    });

    it('orders oldest first and limits to 100', async () => {
      const repo = mockRepo();
      const repository = new TypeormZaloLinkVerifyRecordRepository(
        repo as never,
      );

      await repository.listStaleRecords(120_000);

      expect(repo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          order: { verifiedAt: 'ASC' },
          take: 100,
        }),
      );
    });

    it('maps rows to StaleZaloVerifyRecord shape', async () => {
      const repo = mockRepo();
      const now = new Date();
      repo.find.mockResolvedValue([
        { zaloUserId: 'z1', userId: 1, verifiedAt: now },
      ]);
      const repository = new TypeormZaloLinkVerifyRecordRepository(
        repo as never,
      );

      const result = await repository.listStaleRecords(120_000);
      expect(result).toEqual([
        { zaloUserId: 'z1', userId: 1, verifiedAt: now },
      ]);
    });
  });
  describe('recordVerify', () => {
    it('upserts verify intent idempotently by zaloUserId', async () => {
      const repo = mockRepo();
      const repository = new TypeormZaloLinkVerifyRecordRepository(
        repo as never,
      );

      await repository.recordVerify('zalo-1', 42);

      expect(repo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ zaloUserId: 'zalo-1', userId: 42 }),
        ['zaloUserId'],
      );
    });
  });
});
