import { MessengerMappingService } from './messenger-mapping.service';

describe('MessengerMappingService', () => {
  const makePrefs = () => ({
    setReportEnabled: jest.fn().mockResolvedValue(undefined),
    setReminderEnabled: jest.fn().mockResolvedValue(undefined),
  });

  it('detects relink when user_id changes for same PSID (L3)', async () => {
    const notificationPreferences = makePrefs();
    const repository = {
      findActiveMappingByPsid: jest.fn(() =>
        Promise.resolve({ userId: 100, psid: 'psid-1' }),
      ),
      findActiveMappingByUserId: jest.fn(() => Promise.resolve(null)),
      deactivateConflictingActiveMappings: jest.fn(() => Promise.resolve()),
      upsertPsidUserLink: jest.fn(() =>
        Promise.resolve({
          id: 1,
          userId: 200,
          psid: 'psid-1',
          notificationMessagesToken: 'token',
          status: 'ACTIVE',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      ),
    };

    const outbound = {
      sendTextViaPsid: jest.fn(() => Promise.resolve()),
    };

    const studyReminderSyncService = {
      syncUpcomingSessions: jest.fn(() => Promise.resolve({})),
    };

    const service = new MessengerMappingService(
      repository as never,
      outbound as never,
      studyReminderSyncService as never,
      { getUpcomingSessions: jest.fn().mockResolvedValue([]) } as never,
      { clear: jest.fn().mockResolvedValue(true) } as never,
      notificationPreferences as never,
    );

    const result = await service.relinkPsidToUserId({
      psid: 'psid-1',
      userId: 200,
      allowRelink: true,
    });

    expect(result.relinked).toBe(true);
    expect(result.previousUserId).toBe(100);
    expect(outbound.sendTextViaPsid).toHaveBeenCalledWith(
      expect.objectContaining({ messageType: 'MAPPING_USER_ID_UPDATED' }),
    );
    expect(studyReminderSyncService.syncUpcomingSessions).toHaveBeenCalledWith({
      userId: 200,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      getSessions: expect.any(Function),
    });
    // Relink without cadence/topic → explainer, no consent write (#596).
    expect(notificationPreferences.setReportEnabled).not.toHaveBeenCalled();
  });

  it('write-syncs report_enabled on a link that carries cadence+topic (#596)', async () => {
    const notificationPreferences = makePrefs();
    const repository = {
      findActiveMappingByPsid: jest.fn(() => Promise.resolve(null)),
      findActiveMappingByUserId: jest.fn(() => Promise.resolve(null)),
      upsertPsidUserLink: jest.fn(() =>
        Promise.resolve({
          id: 1,
          userId: 200,
          psid: 'psid-1',
          notificationMessagesToken: 'token',
          status: 'ACTIVE',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      ),
    };
    const outbound = { sendTextViaPsid: jest.fn(() => Promise.resolve()) };
    const service = new MessengerMappingService(
      repository as never,
      outbound as never,
      { syncUpcomingSessions: jest.fn().mockResolvedValue({}) } as never,
      { getUpcomingSessions: jest.fn().mockResolvedValue([]) } as never,
      { clear: jest.fn().mockResolvedValue(true) } as never,
      notificationPreferences as never,
    );

    await service.linkFromContext('psid-1', {
      ref: 'token',
      userId: 200,
      topic: 'IELTS',
      cadence: 'WEEKLY',
    });

    expect(notificationPreferences.setReportEnabled).toHaveBeenCalledWith(
      200,
      true,
    );
    // Already subscribed → no explainer prompt.
    expect(outbound.sendTextViaPsid).not.toHaveBeenCalledWith(
      expect.objectContaining({ messageType: 'CONSENT_EXPLAINER' }),
    );
  });

  it('sends the consent explainer when linked without a report subscription (#596)', async () => {
    const notificationPreferences = makePrefs();
    const repository = {
      findActiveMappingByPsid: jest.fn(() => Promise.resolve(null)),
      findActiveMappingByUserId: jest.fn(() => Promise.resolve(null)),
      upsertPsidUserLink: jest.fn(() =>
        Promise.resolve({
          id: 1,
          userId: 200,
          psid: 'psid-1',
          notificationMessagesToken: 'token',
          status: 'ACTIVE',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      ),
    };
    const outbound = { sendTextViaPsid: jest.fn(() => Promise.resolve()) };
    const service = new MessengerMappingService(
      repository as never,
      outbound as never,
      { syncUpcomingSessions: jest.fn().mockResolvedValue({}) } as never,
      { getUpcomingSessions: jest.fn().mockResolvedValue([]) } as never,
      { clear: jest.fn().mockResolvedValue(true) } as never,
      notificationPreferences as never,
    );

    await service.relinkPsidToUserId({
      psid: 'psid-1',
      userId: 200,
      notifyUser: true,
    });

    expect(outbound.sendTextViaPsid).toHaveBeenCalledWith(
      expect.objectContaining({ messageType: 'CONSENT_EXPLAINER' }),
    );
    expect(notificationPreferences.setReportEnabled).not.toHaveBeenCalled();
  });

  it('blocks relink for webhook flow unless allowRelink is true (L4)', async () => {
    const repository = {
      findActiveMappingByPsid: jest.fn(() =>
        Promise.resolve({ userId: 100, psid: 'psid-1' }),
      ),
      findActiveMappingByUserId: jest.fn(() => Promise.resolve(null)),
      upsertPsidUserLink: jest.fn(),
    };

    const outbound = {
      sendTextViaPsid: jest.fn(() => Promise.resolve()),
    };

    const studyReminderSyncService = {
      syncUpcomingSessions: jest.fn(() => Promise.resolve({})),
    };

    const service = new MessengerMappingService(
      repository as never,
      outbound as never,
      studyReminderSyncService as never,
      { getUpcomingSessions: jest.fn().mockResolvedValue([]) } as never,
      { clear: jest.fn().mockResolvedValue(true) } as never,
    );

    const result = await service.linkFromContext('psid-1', {
      ref: 'token-b',
      userId: 200,
      topic: 'IELTS',
      cadence: 'WEEKLY',
    });

    expect(result.blocked).toBe(true);
    expect(repository.upsertPsidUserLink).not.toHaveBeenCalled();
    expect(outbound.sendTextViaPsid).toHaveBeenCalledWith(
      expect.objectContaining({ messageType: 'MAPPING_RELINK_BLOCKED' }),
    );
  });

  it('blocks when userId already maps a different PSID (1 user -> 1 psid)', async () => {
    const repository = {
      findActiveMappingByPsid: jest.fn(() => Promise.resolve(null)),
      findActiveMappingByUserId: jest.fn(() =>
        Promise.resolve({ userId: 143, psid: 'psid-old' }),
      ),
      upsertPsidUserLink: jest.fn(),
    };

    const outbound = {
      sendTextViaPsid: jest.fn(() => Promise.resolve()),
    };

    const studyReminderSyncService = {
      syncUpcomingSessions: jest.fn(() => Promise.resolve({})),
    };

    const service = new MessengerMappingService(
      repository as never,
      outbound as never,
      studyReminderSyncService as never,
      { getUpcomingSessions: jest.fn().mockResolvedValue([]) } as never,
      { clear: jest.fn().mockResolvedValue(true) } as never,
    );

    const result = await service.linkFromContext('psid-new', {
      ref: 'token',
      userId: 143,
      topic: 'IELTS',
      cadence: 'WEEKLY',
    });

    expect(result.blocked).toBe(true);
    expect(repository.upsertPsidUserLink).not.toHaveBeenCalled();
    expect(outbound.sendTextViaPsid).toHaveBeenCalledWith(
      expect.objectContaining({ messageType: 'MAPPING_USER_PSID_CONFLICT' }),
    );
  });

  it('clears clarification state after a committed mapping update', async () => {
    const repository = {
      findActiveMappingByPsid: jest.fn(() => Promise.resolve(null)),
      findActiveMappingByUserId: jest.fn(() => Promise.resolve(null)),
      upsertPsidUserLink: jest.fn(() =>
        Promise.resolve({
          id: 1,
          userId: 200,
          psid: 'psid-1',
          notificationMessagesToken: 'token',
          status: 'ACTIVE',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      ),
    };
    const clarificationStateStore = {
      clear: jest.fn().mockResolvedValue(true),
    };

    const service = new MessengerMappingService(
      repository as never,
      { sendTextViaPsid: jest.fn() } as never,
      { syncUpcomingSessions: jest.fn().mockResolvedValue({}) } as never,
      { getUpcomingSessions: jest.fn().mockResolvedValue([]) } as never,
      clarificationStateStore as never,
      makePrefs() as never,
    );

    await service.linkFromContext('psid-1', {
      ref: 'token',
      userId: 200,
      topic: 'IELTS',
      cadence: 'WEEKLY',
    });

    expect(clarificationStateStore.clear).toHaveBeenCalledWith(
      'messenger:psid-1',
    );
  });

  it('#821: claims the matching verify intent before committing the mapping', async () => {
    const claimRecord = jest
      .fn()
      .mockResolvedValue({ status: 'claimed', leaseToken: 'lease-1' });
    const completeRecord = jest.fn().mockResolvedValue('committed');
    const repository = {
      findActiveMappingByPsid: jest.fn(() => Promise.resolve(null)),
      findActiveMappingByUserId: jest.fn(() => Promise.resolve(null)),
      upsertPsidUserLink: jest.fn(() =>
        Promise.resolve({
          id: 1,
          userId: 200,
          psid: 'psid-1',
          notificationMessagesToken: 'token',
          status: 'ACTIVE',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      ),
    };
    const service = new MessengerMappingService(
      repository as never,
      { sendTextViaPsid: jest.fn() } as never,
      { syncUpcomingSessions: jest.fn().mockResolvedValue({}) } as never,
      { getUpcomingSessions: jest.fn().mockResolvedValue([]) } as never,
      { clear: jest.fn().mockResolvedValue(true) } as never,
      makePrefs() as never,
      undefined,
      { claimRecord, completeRecord } as never,
    );

    await service.linkFromContext(
      'psid-1',
      { ref: 'token', userId: 200, topic: 'IELTS', cadence: 'WEEKLY' },
      { intentGeneration: '4', intentLeaseToken: 'lease-owner' },
    );

    expect(claimRecord).toHaveBeenCalledWith({
      psid: 'psid-1',
      userId: 200,
      intentGeneration: '4',
      leaseToken: 'lease-owner',
      leaseMs: expect.any(Number),
    });
    expect(completeRecord).toHaveBeenCalledWith({
      psid: 'psid-1',
      userId: 200,
      intentGeneration: '4',
      leaseToken: 'lease-1',
    });
    expect(claimRecord.mock.invocationCallOrder[0]).toBeLessThan(
      completeRecord.mock.invocationCallOrder[0],
    );
    expect(claimRecord.mock.invocationCallOrder[0]).toBeLessThan(
      repository.upsertPsidUserLink.mock.invocationCallOrder[0],
    );
  });

  it('#821: skips side effects when another callback owns the intent lease', async () => {
    const notificationPreferences = makePrefs();
    const claimRecord = jest
      .fn()
      .mockResolvedValue({ status: 'already_processing' });
    const repository = {
      findActiveMappingByPsid: jest.fn(() => Promise.resolve(null)),
      findActiveMappingByUserId: jest.fn(() => Promise.resolve(null)),
      upsertPsidUserLink: jest.fn(() =>
        Promise.resolve({
          id: 1,
          userId: 200,
          psid: 'psid-1',
          notificationMessagesToken: 'token',
          status: 'ACTIVE',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      ),
    };
    const outbound = { sendTextViaPsid: jest.fn() };
    const sync = { syncUpcomingSessions: jest.fn() };
    const service = new MessengerMappingService(
      repository as never,
      outbound as never,
      sync as never,
      { getUpcomingSessions: jest.fn().mockResolvedValue([]) } as never,
      { clear: jest.fn() } as never,
      notificationPreferences as never,
      undefined,
      { claimRecord } as never,
    );

    const result = await service.linkFromContext(
      'psid-1',
      { ref: 'token', userId: 200, topic: 'IELTS', cadence: 'WEEKLY' },
      { intentGeneration: '4' },
    );

    expect(result.blocked).toBe(true);
    expect(repository.upsertPsidUserLink).not.toHaveBeenCalled();
    expect(notificationPreferences.setReportEnabled).not.toHaveBeenCalled();
    expect(sync.syncUpcomingSessions).not.toHaveBeenCalled();
    expect(outbound.sendTextViaPsid).not.toHaveBeenCalled();
  });

  it('#821: never commits or runs side effects for a superseded generation', async () => {
    const notificationPreferences = makePrefs();
    const claimRecord = jest.fn().mockResolvedValue({ status: 'not_found' });
    const repository = {
      findActiveMappingByPsid: jest.fn(() => Promise.resolve(null)),
      findActiveMappingByUserId: jest.fn(() => Promise.resolve(null)),
      upsertPsidUserLink: jest.fn(),
    };
    const outbound = { sendTextViaPsid: jest.fn() };
    const sync = { syncUpcomingSessions: jest.fn() };
    const service = new MessengerMappingService(
      repository as never,
      outbound as never,
      sync as never,
      { getUpcomingSessions: jest.fn().mockResolvedValue([]) } as never,
      { clear: jest.fn() } as never,
      notificationPreferences as never,
      undefined,
      { claimRecord } as never,
    );

    const result = await service.linkFromContext(
      'psid-1',
      { ref: 'token', userId: 200, topic: 'IELTS', cadence: 'WEEKLY' },
      { intentGeneration: '3' },
    );

    expect(result).toEqual(
      expect.objectContaining({ blocked: true, intentOutcome: 'stale' }),
    );
    expect(repository.upsertPsidUserLink).not.toHaveBeenCalled();
    expect(notificationPreferences.setReportEnabled).not.toHaveBeenCalled();
    expect(sync.syncUpcomingSessions).not.toHaveBeenCalled();
    expect(outbound.sendTextViaPsid).not.toHaveBeenCalled();
  });

  it('#821: leaves the intent recoverable when completion fails after side effects', async () => {
    const claimRecord = jest
      .fn()
      .mockResolvedValue({ status: 'claimed', leaseToken: 'lease-1' });
    const completeRecord = jest
      .fn()
      .mockRejectedValueOnce(new Error('db timeout'))
      .mockResolvedValue('committed');
    const repository = {
      findActiveMappingByPsid: jest.fn(() => Promise.resolve(null)),
      findActiveMappingByUserId: jest.fn(() => Promise.resolve(null)),
      upsertPsidUserLink: jest.fn().mockResolvedValue({
        id: 1,
        userId: 200,
        psid: 'psid-1',
        notificationMessagesToken: 'token',
        status: 'ACTIVE',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    };
    const outbound = { sendTextViaPsid: jest.fn() };
    const sync = { syncUpcomingSessions: jest.fn().mockResolvedValue({}) };
    const service = new MessengerMappingService(
      repository as never,
      outbound as never,
      sync as never,
      { getUpcomingSessions: jest.fn().mockResolvedValue([]) } as never,
      { clear: jest.fn().mockResolvedValue(true) } as never,
      makePrefs() as never,
      undefined,
      { claimRecord, completeRecord } as never,
    );

    const result = await service.linkFromContext(
      'psid-1',
      { ref: 'token', userId: 200, topic: 'IELTS', cadence: 'WEEKLY' },
      { intentGeneration: '4' },
    );

    expect(result).toEqual(
      expect.objectContaining({
        blocked: true,
        intentOutcome: 'complete_failed',
      }),
    );
    expect(sync.syncUpcomingSessions).toHaveBeenCalled();
    expect(outbound.sendTextViaPsid).not.toHaveBeenCalled();

    const retry = await service.linkFromContext(
      'psid-1',
      { ref: 'token', userId: 200, topic: 'IELTS', cadence: 'WEEKLY' },
      { intentGeneration: '4' },
    );

    expect(retry.blocked).not.toBe(true);
    expect(completeRecord).toHaveBeenCalledTimes(2);
  });

  it('#821: lets one concurrent callback own the mapping side effects', async () => {
    let releaseUpsert!: () => void;
    const upsertGate = new Promise<void>((resolve) => {
      releaseUpsert = resolve;
    });
    let claimCount = 0;
    const claimRecord = jest.fn().mockImplementation(() => {
      claimCount += 1;
      return Promise.resolve(
        claimCount === 1
          ? { status: 'claimed', leaseToken: 'lease-1' }
          : { status: 'already_processing' },
      );
    });
    const completeRecord = jest.fn().mockResolvedValue('committed');
    const repository = {
      findActiveMappingByPsid: jest.fn(() => Promise.resolve(null)),
      findActiveMappingByUserId: jest.fn(() => Promise.resolve(null)),
      upsertPsidUserLink: jest.fn(async () => {
        await upsertGate;
        return {
          id: 1,
          userId: 200,
          psid: 'psid-1',
          notificationMessagesToken: 'token',
          status: 'ACTIVE',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }),
    };
    const service = new MessengerMappingService(
      repository as never,
      { sendTextViaPsid: jest.fn() } as never,
      { syncUpcomingSessions: jest.fn().mockResolvedValue({}) } as never,
      { getUpcomingSessions: jest.fn().mockResolvedValue([]) } as never,
      { clear: jest.fn().mockResolvedValue(true) } as never,
      makePrefs() as never,
      undefined,
      { claimRecord, completeRecord } as never,
    );

    const first = service.linkFromContext(
      'psid-1',
      { ref: 'token', userId: 200, topic: 'IELTS', cadence: 'WEEKLY' },
      { intentGeneration: '4' },
    );
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (repository.upsertPsidUserLink.mock.calls.length > 0) {
          resolve();
        } else {
          setImmediate(check);
        }
      };
      check();
    });

    const second = await service.linkFromContext(
      'psid-1',
      { ref: 'token', userId: 200, topic: 'IELTS', cadence: 'WEEKLY' },
      { intentGeneration: '4' },
    );
    releaseUpsert();
    const firstResult = await first;

    expect(firstResult.blocked).not.toBe(true);
    expect(second).toEqual(
      expect.objectContaining({
        blocked: true,
        intentOutcome: 'already_processing',
      }),
    );
    expect(repository.upsertPsidUserLink).toHaveBeenCalledTimes(1);
    expect(completeRecord).toHaveBeenCalledTimes(1);
  });

  it('#821: renews the owner lease while a link side effect is still running', async () => {
    jest.useFakeTimers();
    try {
      let releaseSync!: () => void;
      const syncGate = new Promise<void>((resolve) => {
        releaseSync = resolve;
      });
      const renewRecord = jest.fn().mockResolvedValue(true);
      const claimRecord = jest
        .fn()
        .mockResolvedValue({ status: 'claimed', leaseToken: 'lease-1' });
      const completeRecord = jest.fn().mockResolvedValue('committed');
      const repository = {
        findActiveMappingByPsid: jest.fn().mockResolvedValue(null),
        findActiveMappingByUserId: jest.fn().mockResolvedValue(null),
        upsertPsidUserLink: jest.fn().mockResolvedValue({
          id: 1,
          userId: 200,
          psid: 'psid-1',
          notificationMessagesToken: 'token',
          status: 'ACTIVE',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      };
      const service = new MessengerMappingService(
        repository as never,
        { sendTextViaPsid: jest.fn() } as never,
        { syncUpcomingSessions: jest.fn(() => syncGate) } as never,
        { getUpcomingSessions: jest.fn().mockResolvedValue([]) } as never,
        { clear: jest.fn().mockResolvedValue(true) } as never,
        makePrefs() as never,
        undefined,
        { claimRecord, renewRecord, completeRecord } as never,
      );

      const link = service.linkFromContext(
        'psid-1',
        { ref: 'token', userId: 200, topic: 'IELTS', cadence: 'WEEKLY' },
        { intentGeneration: '4', intentLeaseToken: 'lease-1' },
      );
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(20_000);

      expect(renewRecord).toHaveBeenCalledWith({
        psid: 'psid-1',
        userId: 200,
        intentGeneration: '4',
        leaseToken: 'lease-1',
        leaseMs: expect.any(Number),
      });

      releaseSync();
      await link;
      expect(completeRecord).toHaveBeenCalledWith({
        psid: 'psid-1',
        userId: 200,
        intentGeneration: '4',
        leaseToken: 'lease-1',
      });
    } finally {
      jest.useRealTimers();
    }
  });
});
