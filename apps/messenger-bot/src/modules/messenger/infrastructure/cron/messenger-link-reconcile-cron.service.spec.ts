import { MessengerLinkReconcileCronService } from './messenger-link-reconcile-cron.service';

describe('MessengerLinkReconcileCronService', () => {
  const createService = (overrides?: {
    listStaleRecords?: jest.Mock;
    discardRecord?: jest.Mock;
    cleanupCommittedRecords?: jest.Mock;
    findActiveMappingByPsid?: jest.Mock;
    linkFromContext?: jest.Mock;
    withLock?: jest.Mock;
    get?: jest.Mock;
  }) => {
    const verifyRecordService = {
      recordVerify: jest.fn(),
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
    };

    const mappingService = {
      linkFromContext:
        overrides?.linkFromContext ??
        jest.fn().mockResolvedValue({ blocked: false }),
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
      mappingService as never,
      configService as never,
      pgLock as never,
    );

    return {
      service,
      verifyRecordService,
      mappingRepository,
      mappingService,
      pgLock,
    };
  };

  it('skips when no stale records', async () => {
    const { service, mappingRepository } = createService();
    await service.handleReconcile();
    expect(mappingRepository.findActiveMappingByPsid).not.toHaveBeenCalled();
  });

  it('replays an already committed mapping through the lease-aware completion service', async () => {
    const { service, mappingService, mappingRepository } = createService({
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

    expect(mappingService.linkFromContext).toHaveBeenCalledWith(
      'psid-1',
      { ref: '', userId: 143, topic: undefined, cadence: undefined },
      { notifyUser: false, intentGeneration: undefined },
    );
    expect(mappingRepository.findActiveMappingByPsid).toHaveBeenCalledWith(
      'psid-1',
    );
  });

  it('re-commits mapping when missing and within max age', async () => {
    const { service, mappingService } = createService({
      listStaleRecords: jest
        .fn()
        .mockResolvedValue([
          { psid: 'psid-2', userId: 200, verifiedAt: new Date() },
        ]),
    });

    await service.handleReconcile();

    expect(mappingService.linkFromContext).toHaveBeenCalledWith(
      'psid-2',
      { ref: '', userId: 200, topic: undefined, cadence: undefined },
      { notifyUser: false, intentGeneration: undefined },
    );
  });

  it('reclaims an expired processing lease through the same completion path', async () => {
    const { service, mappingService } = createService({
      listStaleRecords: jest.fn().mockResolvedValue([
        {
          psid: 'psid-processing',
          userId: 201,
          status: 'processing',
          intentGeneration: '8',
          leaseExpiresAt: new Date(Date.now() - 1_000),
          verifiedAt: new Date(),
        },
      ]),
    });

    await service.handleReconcile();

    expect(mappingService.linkFromContext).toHaveBeenCalledWith(
      'psid-processing',
      { ref: '', userId: 201, topic: undefined, cadence: undefined },
      { notifyUser: false, intentGeneration: '8' },
    );
  });

  it('drops record when older than max age with no mapping', async () => {
    const oldTime = new Date(Date.now() - 4_000_000); // > 3,600,000 default
    const { service, verifyRecordService, mappingService } = createService({
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
    expect(mappingService.linkFromContext).not.toHaveBeenCalled();
  });

  it('handles completion failure without crashing', async () => {
    const { service, mappingService } = createService({
      listStaleRecords: jest
        .fn()
        .mockResolvedValue([
          { psid: 'psid-4', userId: 400, verifiedAt: new Date() },
        ]),
      linkFromContext: jest.fn().mockRejectedValue(new Error('db down')),
    });

    await expect(service.handleReconcile()).resolves.not.toThrow();
    expect(mappingService.linkFromContext).toHaveBeenCalled();
  });

  it('#821: keeps a fresh mismatched mapping actionable', async () => {
    const { service, mappingService, verifyRecordService } = createService({
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

    expect(mappingService.linkFromContext).not.toHaveBeenCalled();
    expect(verifyRecordService.discardRecord).not.toHaveBeenCalled();
  });

  it('#821: restores metadata before completing a matching intent', async () => {
    const { service, mappingService } = createService({
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

    expect(mappingService.linkFromContext).toHaveBeenCalledWith(
      'psid-metadata',
      {
        ref: 'fingerprint',
        userId: 200,
        topic: 'IELTS Writing',
        cadence: 'DAILY',
      },
      { notifyUser: false, intentGeneration: '5' },
    );
  });

  it('does not run a second batch while another pod owns the advisory lock', async () => {
    const withLock = jest.fn().mockResolvedValue(null);
    const { service, verifyRecordService } = createService({ withLock });

    await service.handleReconcile();

    expect(withLock).toHaveBeenCalled();
    expect(verifyRecordService.listStaleRecords).not.toHaveBeenCalled();
  });
});
