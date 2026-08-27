import { MessengerMappingService } from './messenger-mapping.service';

describe('MessengerMappingService', () => {
  it('detects relink when user_id changes for same PSID (L3)', async () => {
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
});
