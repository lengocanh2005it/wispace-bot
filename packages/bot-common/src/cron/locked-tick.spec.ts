import { runLockedTick, type LockedTickItem } from './locked-tick';

describe('runLockedTick', () => {
  function build(options?: {
    lockResult?: unknown;
    enabled?: boolean;
    items?: LockedTickItem<string>[];
  }) {
    const withLock = jest.fn(async <T>(run: () => Promise<T>) => {
      if (options?.lockResult === null) return null;
      return options?.lockResult === undefined
        ? run()
        : (options.lockResult as T);
    });
    const recordCronSuccess = jest.fn();
    const debug = jest.fn();
    const run = jest.fn().mockResolvedValue(options?.items ?? []);

    return {
      withLock,
      recordCronSuccess,
      debug,
      run,
      options: {
        name: 'test-tick',
        enabled: options?.enabled ?? true,
        withLock,
        run,
        metrics: { recordCronSuccess },
        logger: { debug },
      },
    };
  }

  it('returns null without acquiring the lock when disabled', async () => {
    const built = build({ enabled: false });

    await expect(runLockedTick(built.options)).resolves.toBeNull();

    expect(built.withLock).not.toHaveBeenCalled();
    expect(built.run).not.toHaveBeenCalled();
    expect(built.recordCronSuccess).not.toHaveBeenCalled();
  });

  it('skips the batch and success metric when the lock is held', async () => {
    const built = build({ lockResult: null });

    await expect(runLockedTick(built.options)).resolves.toBeNull();

    expect(built.run).not.toHaveBeenCalled();
    expect(built.debug).toHaveBeenCalledWith(
      'test-tick skipped — lock held by another pod',
    );
    expect(built.recordCronSuccess).not.toHaveBeenCalled();
  });

  it('summarizes an empty batch as successful zero work', async () => {
    const built = build();

    await expect(runLockedTick(built.options)).resolves.toEqual({
      processed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      details: [],
    });

    expect(built.recordCronSuccess).toHaveBeenCalledWith('test-tick');
  });

  it('counts outcomes and preserves service details', async () => {
    const built = build({
      items: [
        { outcome: 'succeeded', details: 'sent' },
        { outcome: 'failed', details: 'retryable' },
        { outcome: 'skipped', details: 'claim-lost' },
      ],
    });

    await expect(runLockedTick(built.options)).resolves.toEqual({
      processed: 3,
      succeeded: 1,
      failed: 1,
      skipped: 1,
      details: ['sent', 'retryable', 'claim-lost'],
    });
  });

  it('propagates batch errors and does not report success', async () => {
    const built = build();
    built.run.mockRejectedValue(new Error('fetch failed'));

    await expect(runLockedTick(built.options)).rejects.toThrow('fetch failed');
    expect(built.recordCronSuccess).not.toHaveBeenCalled();
  });

  it('rejects an invalid tick configuration before acquiring the lock', async () => {
    const withLock = jest.fn(async (run: () => Promise<unknown>) => run());

    await expect(
      runLockedTick({ name: 'invalid-tick', withLock }),
    ).rejects.toThrow('requires run or fetchBatch/processItem');
    expect(withLock).not.toHaveBeenCalled();
  });

  it('continues after an item failure when it owns the batch loop', async () => {
    const processItem = jest
      .fn()
      .mockRejectedValueOnce(new Error('one item failed'))
      .mockResolvedValueOnce({ outcome: 'succeeded' as const, details: 'ok' });

    await expect(
      runLockedTick({
        name: 'item-tick',
        withLock: async (run) => run(),
        fetchBatch: async () => ['first', 'second'],
        processItem,
      }),
    ).resolves.toEqual({
      processed: 2,
      succeeded: 1,
      failed: 1,
      skipped: 0,
      details: ['ok'],
    });
    expect(processItem).toHaveBeenCalledTimes(2);
  });
});
