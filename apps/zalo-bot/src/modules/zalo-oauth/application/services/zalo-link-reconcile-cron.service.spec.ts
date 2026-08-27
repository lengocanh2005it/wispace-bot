import type { ConfigService } from '@nestjs/config';
import type { PgAdvisoryLockService } from '@wispace/bot-common/locks';
import type { ZaloAccountLinkService } from './zalo-account-link.service';
import type { ZaloLinkVerifyRecordRepositoryPort } from '../../domain/ports/zalo-link-verify-record.repository.port';
import { ZaloLinkReconcileCronService } from './zalo-link-reconcile-cron.service';

const DEFAULT_CONFIG: Record<string, string> = {
  ZALO_LINK_RECONCILE_AGE_MS: '120000',
  ZALO_LINK_RECONCILE_MAX_AGE_MS: '600000',
};

function buildConfigService(
  overrides: Record<string, string> = {},
): ConfigService {
  return {
    get: (key: string) => ({ ...DEFAULT_CONFIG, ...overrides })[key],
  } as unknown as ConfigService;
}

function buildPgLock(lockId: number): PgAdvisoryLockService {
  return {
    withLock: jest.fn((id: number, fn: () => Promise<unknown>) =>
      Promise.resolve(id === lockId ? fn() : null),
    ),
  } as unknown as PgAdvisoryLockService;
}

function buildHarness(options: {
  records?: Array<{
    zaloUserId: string;
    userId: number;
    verifiedAt: Date;
  }>;
  findUserId?: (zaloUserId: string) => number | undefined;
  upsertError?: Error;
}) {
  const verifyRecordService = {
    listStaleRecords: jest.fn().mockResolvedValue(options.records ?? []),
    consumeRecord: jest.fn().mockResolvedValue(undefined),
  } as unknown as ZaloLinkVerifyRecordRepositoryPort;

  const accountLinkService = {
    findUserIdByZaloId: jest.fn((zaloUserId: string) =>
      Promise.resolve(options.findUserId?.(zaloUserId)),
    ),
    upsertLink: options.upsertError
      ? jest.fn().mockRejectedValue(options.upsertError)
      : jest.fn().mockResolvedValue(undefined),
  } as unknown as ZaloAccountLinkService;

  return { verifyRecordService, accountLinkService };
}

describe('ZaloLinkReconcileCronService', () => {
  it('re-commits a missing mapping from the verify record, then consumes it', async () => {
    const { verifyRecordService, accountLinkService } = buildHarness({
      records: [
        {
          zaloUserId: 'zalo-user-1',
          userId: 42,
          verifiedAt: new Date(Date.now() - 150_000),
        },
      ],
    });
    const cron = new ZaloLinkReconcileCronService(
      verifyRecordService,
      accountLinkService,
      buildConfigService(),
      buildPgLock(884_200_937),
      { clear: jest.fn().mockResolvedValue(true) },
    );

    await cron.handleReconcile();

    expect(accountLinkService.upsertLink).toHaveBeenCalledWith(
      42,
      'zalo-user-1',
    );
    expect(verifyRecordService.consumeRecord).toHaveBeenCalledWith(
      'zalo-user-1',
    );
  });

  it('consumes records whose mapping is already committed with same userId', async () => {
    const { verifyRecordService, accountLinkService } = buildHarness({
      records: [
        {
          zaloUserId: 'zalo-user-1',
          userId: 42,
          verifiedAt: new Date(Date.now() - 150_000),
        },
      ],
      findUserId: () => 42,
    });
    const cron = new ZaloLinkReconcileCronService(
      verifyRecordService,
      accountLinkService,
      buildConfigService(),
      buildPgLock(884_200_937),
      { clear: jest.fn().mockResolvedValue(true) },
    );

    await cron.handleReconcile();

    expect(accountLinkService.upsertLink).not.toHaveBeenCalled();
    expect(verifyRecordService.consumeRecord).toHaveBeenCalledWith(
      'zalo-user-1',
    );
  });

  it('does not consume verify record when existing mapping has a mismatched userId', async () => {
    const { verifyRecordService, accountLinkService } = buildHarness({
      records: [
        {
          zaloUserId: 'zalo-user-1',
          userId: 42,
          verifiedAt: new Date(Date.now() - 150_000),
        },
      ],
      findUserId: () => 999,
    });
    const cron = new ZaloLinkReconcileCronService(
      verifyRecordService,
      accountLinkService,
      buildConfigService(),
      buildPgLock(884_200_937),
      { clear: jest.fn().mockResolvedValue(true) },
    );

    await cron.handleReconcile();

    expect(accountLinkService.upsertLink).not.toHaveBeenCalled();
    expect(verifyRecordService.consumeRecord).not.toHaveBeenCalled();
  });

  it('drops records older than the max age when the mapping is missing', async () => {
    const { verifyRecordService, accountLinkService } = buildHarness({
      records: [
        {
          zaloUserId: 'zalo-user-1',
          userId: 42,
          verifiedAt: new Date(Date.now() - 700_000),
        },
      ],
    });
    const cron = new ZaloLinkReconcileCronService(
      verifyRecordService,
      accountLinkService,
      buildConfigService(),
      buildPgLock(884_200_937),
      { clear: jest.fn().mockResolvedValue(true) },
    );

    await cron.handleReconcile();

    expect(accountLinkService.upsertLink).not.toHaveBeenCalled();
    expect(verifyRecordService.consumeRecord).toHaveBeenCalledWith(
      'zalo-user-1',
    );
  });

  it('keeps the record when reconciliation upsert fails', async () => {
    const { verifyRecordService, accountLinkService } = buildHarness({
      records: [
        {
          zaloUserId: 'zalo-user-1',
          userId: 42,
          verifiedAt: new Date(Date.now() - 150_000),
        },
      ],
      upsertError: new Error('db down'),
    });
    const cron = new ZaloLinkReconcileCronService(
      verifyRecordService,
      accountLinkService,
      buildConfigService(),
      buildPgLock(884_200_937),
      { clear: jest.fn().mockResolvedValue(true) },
    );

    await cron.handleReconcile();

    expect(verifyRecordService.consumeRecord).not.toHaveBeenCalledWith(
      'zalo-user-1',
    );
  });

  it('does nothing when the advisory lock is held elsewhere', async () => {
    const { verifyRecordService, accountLinkService } = buildHarness({
      records: [
        {
          zaloUserId: 'zalo-user-1',
          userId: 42,
          verifiedAt: new Date(Date.now() - 150_000),
        },
      ],
    });
    const cron = new ZaloLinkReconcileCronService(
      verifyRecordService,
      accountLinkService,
      buildConfigService(),
      buildPgLock(999_999),
      { clear: jest.fn().mockResolvedValue(true) },
    );

    await cron.handleReconcile();

    expect(verifyRecordService.listStaleRecords).not.toHaveBeenCalled();
  });
});
