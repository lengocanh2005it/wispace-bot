import type { Repository } from 'typeorm';
import type { LlmSafetyEventEntity } from '../entities/llm-safety-event.entity';
import { LlmSafetyEventRepository } from './llm-safety.repository';

describe('LlmSafetyEventRepository', () => {
  it('deletes expired safety events in bounded batches', async () => {
    const before = new Date('2026-09-01T00:00:00.000Z');
    const fullBatch = Array.from({ length: 1000 }, (_, id) => ({
      id: String(id),
    }));
    const finalBatch = [{ id: '1000' }, { id: '1001' }];
    const query = jest
      .fn()
      .mockResolvedValueOnce([fullBatch, fullBatch.length])
      .mockResolvedValueOnce([finalBatch, finalBatch.length]);
    const repository = new LlmSafetyEventRepository(
      { manager: { query } } as unknown as Repository<LlmSafetyEventEntity>,
      'discord',
    );

    await expect(repository.deleteOlderThan(before)).resolves.toBe(1002);

    expect(query).toHaveBeenCalledTimes(2);
    for (const [sql, parameters] of query.mock.calls) {
      expect(sql).toMatch(/DELETE FROM llm_safety_events/);
      expect(sql).toMatch(/WHERE platform = \$1 AND created_at < \$2/);
      expect(sql).toMatch(/LIMIT \$3/);
      expect(sql).toMatch(/RETURNING id/);
      expect(parameters).toEqual(['discord', before, 1000]);
    }
  });
});
