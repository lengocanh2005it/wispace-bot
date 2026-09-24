import { RescheduleRecoveryCronService } from './reschedule-recovery-cron.service';
import { ADVISORY_LOCKS } from '@wispace/bot-common/locks';

function mockStore() {
  return { recoverStaleProcessing: jest.fn().mockResolvedValue(0) };
}

describe('RescheduleRecoveryCronService', () => {
  it('calls recoverStaleProcessing with 5-minute stale threshold', async () => {
    const store = mockStore();
    const service = new RescheduleRecoveryCronService(store as never);

    await service.handleRecovery();

    expect(store.recoverStaleProcessing).toHaveBeenCalledWith(5 * 60_000);
  });

  it('does not log when no rows are recovered', async () => {
    const store = mockStore();
    store.recoverStaleProcessing.mockResolvedValue(0);
    const service = new RescheduleRecoveryCronService(store as never);

    await expect(service.handleRecovery()).resolves.not.toThrow();
  });

  it('runs recovery under the shared advisory lock when configured (#464)', async () => {
    const store = mockStore();
    store.recoverStaleProcessing.mockResolvedValue(2);
    const pgLock = {
      withLock: jest.fn((_lockId: number, fn: () => Promise<number>) => fn()),
    };
    const service = new RescheduleRecoveryCronService(
      store as never,
      undefined,
      {
        pgLock: pgLock as never,
        lockId: ADVISORY_LOCKS.RESCHEDULE_RECOVERY,
      },
    );

    await service.handleRecovery();

    expect(pgLock.withLock).toHaveBeenCalledWith(
      ADVISORY_LOCKS.RESCHEDULE_RECOVERY,
      expect.any(Function),
    );
    expect(ADVISORY_LOCKS.RESCHEDULE_RECOVERY).toBe(884_200_952);
    expect(store.recoverStaleProcessing).toHaveBeenCalledWith(5 * 60_000);
  });

  it('skips recovery without touching the store on lock contention (#464)', async () => {
    const store = mockStore();
    const pgLock = {
      withLock: jest.fn().mockResolvedValue(null),
    };
    const service = new RescheduleRecoveryCronService(
      store as never,
      undefined,
      {
        pgLock: pgLock as never,
        lockId: ADVISORY_LOCKS.RESCHEDULE_RECOVERY,
      },
    );

    await expect(service.handleRecovery()).resolves.not.toThrow();

    expect(pgLock.withLock).toHaveBeenCalledTimes(1);
    expect(store.recoverStaleProcessing).not.toHaveBeenCalled();
  });

  it('runs unlocked (legacy behavior) when no lock is configured', async () => {
    const store = mockStore();
    const service = new RescheduleRecoveryCronService(store as never);

    await service.handleRecovery();

    expect(store.recoverStaleProcessing).toHaveBeenCalledWith(5 * 60_000);
  });
});
