import { RescheduleRecoveryCronService } from './reschedule-recovery-cron.service';

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
});
