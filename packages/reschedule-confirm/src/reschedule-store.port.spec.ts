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

  it('prune removes claimed entries so the Map does not grow', async () => {
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

    // u2 was claimed — prune should have swept it; only u3 remains
    expect(storeSize(store)).toBe(1);
    expect(await store.hasPending('u2')).toBe(false);
  });
});
