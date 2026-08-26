import { MessengerLinkReconcileCronService } from './messenger-link-reconcile-cron.service';

describe('MessengerLinkReconcileCronService', () => {
  const createService = (overrides?: {
    listStaleRecords?: jest.Mock;
    consumeRecord?: jest.Mock;
    findActiveMappingByPsid?: jest.Mock;
    upsertPsidUserLink?: jest.Mock;
    withLock?: jest.Mock;
    get?: jest.Mock;
  }) => {
    const verifyRecordService = {
      recordVerify: jest.fn(),
      consumeRecord:
        overrides?.consumeRecord ?? jest.fn().mockResolvedValue(undefined),
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

    expect(verifyRecordService.consumeRecord).toHaveBeenCalledWith('psid-1');
    expect(mappingRepository.upsertPsidUserLink).not.toHaveBeenCalled();
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
    expect(verifyRecordService.consumeRecord).toHaveBeenCalledWith('psid-2');
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

    expect(verifyRecordService.consumeRecord).toHaveBeenCalledWith('psid-3');
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
});
