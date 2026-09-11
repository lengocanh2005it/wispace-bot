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
    query: jest.fn(),
  };
  return { repo, qb };
}

describe('TypeormDiscordLinkVerifyRecordRepository', () => {
  it('returns a new intent generation for the original mapping observation', async () => {
    const { repo } = buildMockRepo();
    repo.query.mockResolvedValue([{ intent_generation: '2' }]);
    const repository = new TypeormDiscordLinkVerifyRecordRepository(
      repo as never,
    );

    await expect(
      repository.recordVerify('discord-1', 42, {
        kind: 'present',
        generation: '7',
      }),
    ).resolves.toEqual({ intentGeneration: '2' });
  });

  it('only consumes the matching intent generation and user', async () => {
    const { repo } = buildMockRepo();
    repo.query.mockResolvedValue([{ discord_user_id: 'discord-1' }]);
    const repository = new TypeormDiscordLinkVerifyRecordRepository(
      repo as never,
    );

    await expect(
      repository.consumeRecord({
        discordUserId: 'discord-1',
        userId: 42,
        intentGeneration: '2',
      }),
    ).resolves.toBe(true);
  });

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
