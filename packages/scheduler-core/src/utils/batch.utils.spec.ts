import { runBatched } from './batch.utils';

describe('runBatched', () => {
  it('processes all items once and settles one result per item', async () => {
    const calls: number[] = [];
    const results = await runBatched([1, 2, 3, 4, 5], 2, (item) => {
      calls.push(item);
      return Promise.resolve();
    });

    expect(calls.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(results).toHaveLength(5);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
  });

  it('runs at most `concurrency` items concurrently', async () => {
    let active = 0;
    let maxActive = 0;
    await runBatched([1, 2, 3, 4, 5], 2, () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise<void>((resolve) =>
        setTimeout(() => {
          active -= 1;
          resolve();
        }, 10),
      );
    });

    expect(maxActive).toBe(2);
  });

  it('keeps settled results in input order', async () => {
    const results = await runBatched([1, 2, 3], 1, (item) =>
      Promise.resolve(item * 2),
    );
    expect(results.map((r) => r.status)).toEqual([
      'fulfilled',
      'fulfilled',
      'fulfilled',
    ]);
    expect(
      results.map((r) => (r.status === 'fulfilled' ? r.value : null)),
    ).toEqual([2, 4, 6]);
  });
});
