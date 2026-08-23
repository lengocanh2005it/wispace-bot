/* eslint-disable @typescript-eslint/no-unsafe-assignment -- jest.fn() mock */
import { TypeormDiscordLinkVerifyRecordRepository } from './typeorm-discord-link-verify-record.repository';

function buildMockRepo() {
  const qb = {
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
  };
  const repo = {
    createQueryBuilder: jest.fn().mockReturnValue(qb),
    upsert: jest.fn(),
    delete: jest.fn(),
    findOne: jest.fn(),
  };
  return { repo, qb };
}

describe('TypeormDiscordLinkVerifyRecordRepository', () => {
  describe('listStaleRecords', () => {
    it('applies take(100) to bound query results', async () => {
      const { repo, qb } = buildMockRepo();
      const repository = new TypeormDiscordLinkVerifyRecordRepository(
        repo as never,
      );

      await repository.listStaleRecords(60_000);

      expect(qb.take).toHaveBeenCalledWith(100);
    });

    it('orders by verified_at ASC for resumable keyset behavior', async () => {
      const { repo, qb } = buildMockRepo();
      const repository = new TypeormDiscordLinkVerifyRecordRepository(
        repo as never,
      );

      await repository.listStaleRecords(60_000);

      expect(qb.orderBy).toHaveBeenCalledWith('record.verified_at', 'ASC');
    });

    it('filters by verified_at < cutoff', async () => {
      const { repo, qb } = buildMockRepo();
      const repository = new TypeormDiscordLinkVerifyRecordRepository(
        repo as never,
      );

      const before = Date.now();
      await repository.listStaleRecords(60_000);
      const after = Date.now();

      expect(qb.where).toHaveBeenCalledWith(
        'record.verified_at < :cutoff',
        expect.objectContaining({ cutoff: expect.any(Date) }),
      );

      const cutoff = (qb.where.mock.calls[0] as unknown[])[1] as {
        cutoff: Date;
      };
      expect(cutoff.cutoff.getTime()).toBeGreaterThanOrEqual(
        before - 60_000 - 100,
      );
      expect(cutoff.cutoff.getTime()).toBeLessThanOrEqual(after - 60_000 + 100);
    });
  });
});
