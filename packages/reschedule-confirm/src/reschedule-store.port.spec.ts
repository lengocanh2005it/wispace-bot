import { MemoryRescheduleStore } from './reschedule-store.port';

/** Expose internal Map size for leak assertions. */
function storeSize(store: MemoryRescheduleStore<unknown>): number {
  return (store as unknown as { pendingByExternalId: Map<unknown, unknown> })
    .pendingByExternalId.size;
}

describe('MemoryRescheduleStore', () => {
  const future = Date.now() + 60_000;

  it('hasPending returns false after takeValid claims a record', async () => {
    const store = new MemoryRescheduleStore<string>();
    await store.save({
      externalId: 'u1',
      userId: 1,
      calendarId: 10,
      schedulingMode: 'explicit',
      sessionLabel: 'Mon 10:00',
      expiresAt: future,
    });

    expect(await store.hasPending('u1')).toBe(true);
    const taken = await store.takeValid('u1');
    expect(taken).not.toBeNull();
    expect(await store.hasPending('u1')).toBe(false);
  });

  it('requires the exact lease when deleting a claimed record', async () => {
    const store = new MemoryRescheduleStore<string>();
    await store.save({
      externalId: 'u-lease',
      userId: 1,
      calendarId: 10,
      schedulingMode: 'explicit',
      sessionLabel: 'Mon 10:00',
      expiresAt: future,
    });

    const claimed = await store.takeValid('u-lease');
    expect(claimed?.leaseToken).toEqual(expect.any(String));

    await store.cancelClaimed('u-lease', 'wrong-lease');
    expect(storeSize(store)).toBe(1);

    await store.cancelClaimed('u-lease', claimed!.leaseToken!);
    expect(storeSize(store)).toBe(0);
  });

  it('prune preserves claimed entries so in-flight work cannot be evicted', async () => {
    const store = new MemoryRescheduleStore<string>();
    await store.save({
      externalId: 'u2',
      userId: 2,
      calendarId: 20,
      schedulingMode: 'explicit',
      sessionLabel: 'Tue 14:00',
      expiresAt: future,
    });
    expect(storeSize(store)).toBe(1);

    await store.takeValid('u2');
    // Claimed entry still in Map — trigger prune via a new save
    await store.save({
      externalId: 'u3',
      userId: 3,
      calendarId: 30,
      schedulingMode: 'explicit',
      sessionLabel: 'Wed 09:00',
      expiresAt: future,
    });

    // u2 is claimed — prune must keep it while another user stages work.
    expect(storeSize(store)).toBe(2);
    expect(await store.hasPending('u2')).toBe(false);
    expect(
      await store.save({
        externalId: 'u2',
        userId: 2,
        calendarId: 21,
        schedulingMode: 'explicit',
        sessionLabel: 'Tue 15:00',
        expiresAt: future,
      }),
    ).toBe(false);
  });

  it('revert requires the exact lease when releasing a claimed record', async () => {
    const store = new MemoryRescheduleStore<string>();
    await store.save({
      externalId: 'u-revert',
      userId: 4,
      calendarId: 40,
      schedulingMode: 'explicit',
      sessionLabel: 'Thu 16:00',
      expiresAt: future,
    });

    const claimed = await store.takeValid('u-revert');
    expect(claimed?.leaseToken).toEqual(expect.any(String));

    await store.revertToPending('u-revert', 'wrong-lease');
    expect(await store.hasPending('u-revert')).toBe(false);

    await store.revertToPending('u-revert', claimed!.leaseToken!);
    expect(await store.hasPending('u-revert')).toBe(true);
  });
});
