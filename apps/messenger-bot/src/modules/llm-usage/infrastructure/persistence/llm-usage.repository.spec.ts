import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { LlmUsageEventEntity } from '@wispace/chat-metering';
import { LlmUsageRepository } from './llm-usage.repository';

describe('LlmUsageRepository', () => {
  it('inserts usage row via raw SQL', async () => {
    const query = jest.fn(() => Promise.resolve([]));
    const moduleRef = await Test.createTestingModule({
      providers: [
        LlmUsageRepository,
        {
          provide: getRepositoryToken(LlmUsageEventEntity),
          useValue: {
            manager: { query },
          },
        },
      ],
    }).compile();

    const repository = moduleRef.get(LlmUsageRepository);
    await repository.insertUsage({
      usageDate: '2026-06-18',
      feature: 'FREE_FORM_CHAT',
      psid: 'psid-1',
      model: 'gpt-5.4',
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      correlationId: 'mid-1',
      toolRound: 0,
    });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO llm_usage_events'),
      expect.arrayContaining(['2026-06-18', 'FREE_FORM_CHAT', 'psid-1']),
    );
  });

  describe('deleteOlderThan', () => {
    it('deletes in batches of 1000 until exhausted', async () => {
      const query = jest
        .fn<Promise<Array<{ id: string }>>, [string, unknown[]]>()
        .mockResolvedValueOnce(
          Array.from({ length: 1000 }, (_, i) => ({ id: String(i) })),
        )
        .mockResolvedValueOnce(
          Array.from({ length: 1000 }, (_, i) => ({ id: String(i + 1000) })),
        )
        .mockResolvedValueOnce(
          Array.from({ length: 500 }, (_, i) => ({ id: String(i + 2000) })),
        );

      const moduleRef = await Test.createTestingModule({
        providers: [
          LlmUsageRepository,
          {
            provide: getRepositoryToken(LlmUsageEventEntity),
            useValue: { manager: { query } },
          },
        ],
      }).compile();

      const repository = moduleRef.get(LlmUsageRepository);
      const total = await repository.deleteOlderThan(new Date('2026-01-01'));

      expect(total).toBe(2500);
      // 3 calls: 2 full batches + 1 partial batch (loop exits because < 1000)
      expect(query).toHaveBeenCalledTimes(3);
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM llm_usage_events'),
        ['messenger', new Date('2026-01-01'), 1000],
      );
    });

    it('returns 0 when no rows match (empty backlog)', async () => {
      const query = jest.fn().mockResolvedValueOnce([]);
      const moduleRef = await Test.createTestingModule({
        providers: [
          LlmUsageRepository,
          {
            provide: getRepositoryToken(LlmUsageEventEntity),
            useValue: { manager: { query } },
          },
        ],
      }).compile();

      const repository = moduleRef.get(LlmUsageRepository);
      const total = await repository.deleteOlderThan(new Date('2099-01-01'));

      expect(total).toBe(0);
      expect(query).toHaveBeenCalledTimes(1);
    });

    it('handles exactly-full batch (1000 rows) then empty', async () => {
      const query = jest
        .fn()
        .mockResolvedValueOnce(
          Array.from({ length: 1000 }, (_, i) => ({ id: String(i) })),
        )
        .mockResolvedValueOnce([]);

      const moduleRef = await Test.createTestingModule({
        providers: [
          LlmUsageRepository,
          {
            provide: getRepositoryToken(LlmUsageEventEntity),
            useValue: { manager: { query } },
          },
        ],
      }).compile();

      const repository = moduleRef.get(LlmUsageRepository);
      const total = await repository.deleteOlderThan(new Date('2026-01-01'));

      expect(total).toBe(1000);
      // Exactly-full batch triggers a second call to check for more
      expect(query).toHaveBeenCalledTimes(2);
    });

    it('stops after a partial batch', async () => {
      const query = jest
        .fn()
        .mockResolvedValueOnce(
          Array.from({ length: 300 }, (_, i) => ({ id: String(i) })),
        );

      const moduleRef = await Test.createTestingModule({
        providers: [
          LlmUsageRepository,
          {
            provide: getRepositoryToken(LlmUsageEventEntity),
            useValue: { manager: { query } },
          },
        ],
      }).compile();

      const repository = moduleRef.get(LlmUsageRepository);
      const total = await repository.deleteOlderThan(new Date('2026-01-01'));

      expect(total).toBe(300);
      expect(query).toHaveBeenCalledTimes(1);
    });

    it('propagates error on batch failure (retry resumes from next cron tick)', async () => {
      const query = jest
        .fn()
        .mockRejectedValueOnce(new Error('connection timeout'))
        .mockResolvedValueOnce(
          Array.from({ length: 500 }, (_, i) => ({ id: String(i) })),
        );

      const moduleRef = await Test.createTestingModule({
        providers: [
          LlmUsageRepository,
          {
            provide: getRepositoryToken(LlmUsageEventEntity),
            useValue: { manager: { query } },
          },
        ],
      }).compile();

      const repository = moduleRef.get(LlmUsageRepository);

      // First call fails on first batch
      await expect(
        repository.deleteOlderThan(new Date('2026-01-01')),
      ).rejects.toThrow('connection timeout');

      // Second call (simulating next cron tick) picks up remaining rows
      const total = await repository.deleteOlderThan(new Date('2026-01-01'));
      expect(total).toBe(500);
    });
  });
});
