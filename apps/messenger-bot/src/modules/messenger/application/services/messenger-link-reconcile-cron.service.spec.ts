import { MessengerLinkReconcileCronService } from './messenger-link-reconcile-cron.service';

describe('MessengerLinkReconcileCronService', () => {
  const createService = (overrides?: {
    listStaleRecords?: jest.Mock;
    consumeRecord?: jest.Mock;
    discardRecord?: jest.Mock;
    cleanupCommittedRecords?: jest.Mock;
    findActiveMappingByPsid?: jest.Mock;
    upsertPsidUserLink?: jest.Mock;
    withLock?: jest.Mock;
    get?: jest.Mock;
  }) => {
    const verifyRecordService = {
      recordVerify: jest.fn(),
      consumeRecord:
        overrides?.consumeRecord ?? jest.fn().mockResolvedValue(undefined),
      discardRecord:
        overrides?.discardRecord ?? jest.fn().mockResolvedValue(undefined),
      cleanupCommittedRecords:
        overrides?.cleanupCommittedRecords ?? jest.fn().mockResolvedValue(0),
      listStaleRecords:
        overrides?.listStaleRecords ?? jest.fn().mockResolvedValue([]),
    };

    const mappingRepository = {
      findActiveMappingByPsid:
        overrides?.findActiveMappingByPsid ?? jest.fn().mockResolvedValue(null),
      upsertPsidUserLink:
        overrides?.upsertPsidUserLink ?? jest.fn().mockResolvedValue({}),
    };

    const configService = {
      get: overrides?.get ?? jest.fn().mockReturnValue(undefined),
    };

    const pgLock = {
      withLock:
        overrides?.withLock ??
        jest
          .fn()
          .mockImplementation((_id: unknown, fn: () => Promise<unknown>) =>
            fn(),
          ),
    };

    const service = new MessengerLinkReconcileCronService(
      verifyRecordService as never,
      mappingRepository as never,
      configService as never,
      pgLock as never,
    );

    return { service, verifyRecordService, mappingRepository, pgLock };
  };

  it('skips when no stale records', async () => {
    const { service, mappingRepository } = createService();
    await service.handleReconcile();
    expect(mappingRepository.findActiveMappingByPsid).not.toHaveBeenCalled();
  });

  it('consumes record when mapping already committed', async () => {
    const { service, verifyRecordService, mappingRepository } = createService({
      listStaleRecords: jest
        .fn()
        .mockResolvedValue([
          { psid: 'psid-1', userId: 143, verifiedAt: new Date() },
        ]),
      findActiveMappingByPsid: jest
        .fn()
        .mockResolvedValue({ userId: 143, psid: 'psid-1' }),
    });

    await service.handleReconcile();

    expect(mappingRepository.upsertPsidUserLink).toHaveBeenCalledWith({
      psid: 'psid-1',
      userId: 143,
      topic: undefined,
      cadence: undefined,
    });
    expect(verifyRecordService.consumeRecord).toHaveBeenCalledWith({
      psid: 'psid-1',
      userId: 143,
      intentGeneration: undefined,
    });
  });

  it('re-commits mapping when missing and within max age', async () => {
    const { service, verifyRecordService, mappingRepository } = createService({
      listStaleRecords: jest
        .fn()
        .mockResolvedValue([
          { psid: 'psid-2', userId: 200, verifiedAt: new Date() },
        ]),
    });

    await service.handleReconcile();

    expect(mappingRepository.upsertPsidUserLink).toHaveBeenCalledWith({
      psid: 'psid-2',
      userId: 200,
    });
    expect(verifyRecordService.consumeRecord).toHaveBeenCalledWith({
      psid: 'psid-2',
      userId: 200,
      intentGeneration: undefined,
    });
  });

  it('drops record when older than max age with no mapping', async () => {
    const oldTime = new Date(Date.now() - 4_000_000); // > 3,600,000 default
    const { service, verifyRecordService, mappingRepository } = createService({
      listStaleRecords: jest
        .fn()
        .mockResolvedValue([
          { psid: 'psid-3', userId: 300, verifiedAt: oldTime },
        ]),
    });

    await service.handleReconcile();

    expect(verifyRecordService.discardRecord).toHaveBeenCalledWith(
      'psid-3',
      undefined,
    );
    expect(mappingRepository.upsertPsidUserLink).not.toHaveBeenCalled();
  });

  it('handles upsert failure without crashing', async () => {
    const { service, verifyRecordService } = createService({
      listStaleRecords: jest
        .fn()
        .mockResolvedValue([
          { psid: 'psid-4', userId: 400, verifiedAt: new Date() },
        ]),
      upsertPsidUserLink: jest.fn().mockRejectedValue(new Error('db down')),
    });

    await expect(service.handleReconcile()).resolves.not.toThrow();
    expect(verifyRecordService.consumeRecord).not.toHaveBeenCalled();
  });

  it('#821: keeps a fresh mismatched mapping actionable', async () => {
    const { service, verifyRecordService, mappingRepository } = createService({
      listStaleRecords: jest.fn().mockResolvedValue([
        {
          psid: 'psid-mismatch',
          userId: 200,
          topic: 'IELTS Writing',
          cadence: 'DAILY',
          refFingerprint: 'fingerprint',
          intentGeneration: '4',
          status: 'pending',
          verifiedAt: new Date(),
        },
      ]),
      findActiveMappingByPsid: jest
        .fn()
        .mockResolvedValue({ userId: 100, psid: 'psid-mismatch' }),
    });

    await service.handleReconcile();

    expect(mappingRepository.upsertPsidUserLink).not.toHaveBeenCalled();
    expect(verifyRecordService.consumeRecord).not.toHaveBeenCalled();
    expect(verifyRecordService.discardRecord).not.toHaveBeenCalled();
  });

  it('#821: restores metadata before consuming a matching intent', async () => {
    const { service, verifyRecordService, mappingRepository } = createService({
      listStaleRecords: jest.fn().mockResolvedValue([
        {
          psid: 'psid-metadata',
          userId: 200,
          topic: 'IELTS Writing',
          cadence: 'DAILY',
          refFingerprint: 'fingerprint',
          intentGeneration: '5',
          status: 'pending',
          verifiedAt: new Date(),
        },
      ]),
      findActiveMappingByPsid: jest
        .fn()
        .mockResolvedValue({ userId: 200, psid: 'psid-metadata' }),
    });

    await service.handleReconcile();

    expect(mappingRepository.upsertPsidUserLink).toHaveBeenCalledWith({
      psid: 'psid-metadata',
      userId: 200,
      topic: 'IELTS Writing',
      cadence: 'DAILY',
    });
    expect(verifyRecordService.consumeRecord).toHaveBeenCalledWith({
      psid: 'psid-metadata',
      userId: 200,
      intentGeneration: '5',
    });
  });
});
