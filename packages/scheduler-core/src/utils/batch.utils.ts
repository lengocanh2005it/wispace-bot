/**
 * Run `fn` over `items` in fixed-size batches — `concurrency` items start at
 * once; results keep the input order, settled (fulfilled or rejected).
 */
export async function runBatched<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<unknown>,
): Promise<PromiseSettledResult<unknown>[]> {
  const results: PromiseSettledResult<unknown>[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    results.push(...(await Promise.allSettled(batch.map(fn))));
  }
  return results;
}
