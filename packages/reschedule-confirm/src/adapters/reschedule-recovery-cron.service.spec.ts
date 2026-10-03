import { RescheduleRecoveryCronService } from './reschedule-recovery-cron.service';
import {
  MemoryRescheduleAttemptStore,
  MAX_NOTIFICATION_ATTEMPTS,
} from '../reschedule-attempt.port';

describe('RescheduleRecoveryCronService (#1418)', () => {
  const externalId = 'psid-1';
  const nonce = '11111111-1111-4111-8111-111111111111';

  const build = (
    stale: Array<{ id: number; externalId: string; nonce: string }>,
    attemptStore = new MemoryRescheduleAttemptStore('messenger'),
    deliver: jest.Mock = jest.fn().mockResolvedValue('sent'),
  ) => {
    const store = {
      listStaleProcessing: jest.fn().mockResolvedValue(stale),
      revertStaleRow: jest.fn().mockResolvedValue(undefined),
      cancelStaleRow: jest.fn().mockResolvedValue(undefined),
    };
    const service = new RescheduleRecoveryCronService(
      store as never,
      undefined,
      undefined,
      attemptStore,
      { deliver, limit: 10 },
    );
    return { service, store, attemptStore, deliver };
  };

  const attempt = async (
    store: MemoryRescheduleAttemptStore,
    status: 'attempting' | 'confirmed',
  ) => {
    await store.beginAttempt({
      externalId,
      nonce,
      userId: 42,
    });
    if (status === 'confirmed') {
      await store.confirmAttempt({
        externalId,
        nonce,
        scheduledTimeLabel: '20/09 lúc 19:00',
      });
    }
  };

  it('re-arms a stale request whose write was never attempted', async () => {
    const { service, store } = build([{ id: 1, externalId, nonce }]);

    await service.handleRecovery();

    expect(store.revertStaleRow).toHaveBeenCalledWith(1);
    expect(store.cancelStaleRow).not.toHaveBeenCalled();
  });

  it('never re-arms a stale request whose write outcome is unknown', async () => {
    const attemptStore = new MemoryRescheduleAttemptStore('messenger');
    await attempt(attemptStore, 'attempting');
    const { service, store } = build(
      [{ id: 1, externalId, nonce }],
      attemptStore,
    );

    await service.handleRecovery();

    // The write may already have committed and is not idempotent, so the
    // request is released for the learner rather than re-armed.
    expect(store.revertStaleRow).not.toHaveBeenCalled();
    expect(store.cancelStaleRow).toHaveBeenCalledWith(1);
  });

  it('releases a stale request whose write already committed', async () => {
    const attemptStore = new MemoryRescheduleAttemptStore('messenger');
    await attempt(attemptStore, 'confirmed');
    const { service, store } = build(
      [{ id: 1, externalId, nonce }],
      attemptStore,
    );

    await service.handleRecovery();

    expect(store.revertStaleRow).not.toHaveBeenCalled();
    expect(store.cancelStaleRow).toHaveBeenCalledWith(1);
  });

  it('replays the confirmation whose delivery was deferred', async () => {
    const attemptStore = new MemoryRescheduleAttemptStore('messenger');
    await attempt(attemptStore, 'confirmed');
    await attemptStore.deferNotification(
      externalId,
      nonce,
      new Date(Date.now() - 1000),
    );
    const { service, deliver } = build([], attemptStore);

    await service.handleRecovery();

    expect(deliver).toHaveBeenCalledWith({
      externalId,
      scheduledTimeLabel: '20/09 lúc 19:00',
      userId: 42,
    });
    expect(await attemptStore.findAttempt(externalId, nonce)).toMatchObject({
      notificationStatus: 'delivered',
    });
  });

  it('stops retrying the confirmation once the bound is reached', async () => {
    const attemptStore = new MemoryRescheduleAttemptStore('messenger');
    await attempt(attemptStore, 'confirmed');
    for (let i = 0; i < MAX_NOTIFICATION_ATTEMPTS; i++) {
      await attemptStore.deferNotification(
        externalId,
        nonce,
        new Date(Date.now() - 1000),
      );
    }
    const { service, deliver } = build([], attemptStore);

    await service.handleRecovery();

    // Exhausted, so nothing is offered to the learner again.
    expect(deliver).not.toHaveBeenCalled();
  });

  it('leaves an ambiguous delivery alone rather than re-sending it', async () => {
    const attemptStore = new MemoryRescheduleAttemptStore('messenger');
    await attempt(attemptStore, 'confirmed');
    await attemptStore.markNotificationAmbiguous(externalId, nonce);
    const { service, deliver } = build([], attemptStore);

    await service.handleRecovery();

    expect(deliver).not.toHaveBeenCalled();
  });

  it('recovers stale requests even when no transport is wired', async () => {
    const store = {
      listStaleProcessing: jest
        .fn()
        .mockResolvedValue([{ id: 1, externalId, nonce }]),
      revertStaleRow: jest.fn().mockResolvedValue(undefined),
      cancelStaleRow: jest.fn(),
    };
    const service = new RescheduleRecoveryCronService(
      store as never,
      undefined,
      undefined,
      new MemoryRescheduleAttemptStore('messenger'),
      undefined,
    );

    await expect(service.handleRecovery()).resolves.toBeUndefined();

    expect(store.revertStaleRow).toHaveBeenCalledWith(1);
  });
});
