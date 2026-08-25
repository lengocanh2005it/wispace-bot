/* eslint-disable @typescript-eslint/unbound-method -- Jest mock method assertions */
import type { ConfigService } from '@nestjs/config';
import type { PgAdvisoryLockService } from '@wispace/bot-common';
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

function buildHarness(
  options: {
    records?: Array<{
      zaloUserId: string;
      userId: number;
      verifiedAt: Date;
    }>;
    findUserId?: (zaloUserId: string) => number | undefined;
    upsertError?: Error;
  } = {},
) {
  const verifyRecordService = {
    listStaleRecords: jest.fn().mockResolvedValue(options.records || []),
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

describe('ZaloLinkReconcileCronService (#147)', () => {
  it('re-commits a missing mapping from the verify record, then consumes it', async () => {
    const { verifyRecordService, accountLinkService } = buildHarness({
      records: [
        {
          zaloUserId: 'zalo-user-1',
          userId: 143,
          verifiedAt: new Date(Date.now() - 120_000),
        },
      ],
    });
    const cron = new ZaloLinkReconcileCronService(
      verifyRecordService,
      accountLinkService,
      buildConfigService(),
      buildPgLock(884_200_937),
    );

    await cron.handleReconcile();

    expect(accountLinkService.upsertLink).toHaveBeenCalledWith(
      143,
      'zalo-user-1',
    );
    expect(verifyRecordService.consumeRecord).toHaveBeenCalledWith(
      'zalo-user-1',
    );
  });

  it('consumes records whose mapping is already committed (leftover consume race)', async () => {
    const { verifyRecordService, accountLinkService } = buildHarness({
      records: [
        {
          zaloUserId: 'zalo-user-1',
          userId: 143,
          verifiedAt: new Date(Date.now() - 120_000),
        },
      ],
      findUserId: () => 143,
    });
    const cron = new ZaloLinkReconcileCronService(
      verifyRecordService,
      accountLinkService,
      buildConfigService(),
      buildPgLock(884_200_937),
    );

    await cron.handleReconcile();

    expect(accountLinkService.upsertLink).not.toHaveBeenCalled();
    expect(verifyRecordService.consumeRecord).toHaveBeenCalledWith(
      'zalo-user-1',
    );
  });

  it('drops records older than the max age when the mapping still missing', async () => {
    const { verifyRecordService, accountLinkService } = buildHarness({
      records: [
        {
          zaloUserId: 'zalo-user-1',
          userId: 143,
          verifiedAt: new Date(Date.now() - 700_000), // > 600,000 default
        },
      ],
    });
    const cron = new ZaloLinkReconcileCronService(
      verifyRecordService,
      accountLinkService,
      buildConfigService(),
      buildPgLock(884_200_937),
    );

    await cron.handleReconcile();

    expect(accountLinkService.upsertLink).not.toHaveBeenCalled();
    expect(verifyRecordService.consumeRecord).toHaveBeenCalledWith(
      'zalo-user-1',
    );
  });

  it('keeps the record when upsert fails', async () => {
    const { verifyRecordService, accountLinkService } = buildHarness({
      records: [
        {
          zaloUserId: 'zalo-user-1',
          userId: 143,
          verifiedAt: new Date(Date.now() - 120_000),
        },
      ],
      upsertError: new Error('db down'),
    });
    const cron = new ZaloLinkReconcileCronService(
      verifyRecordService,
      accountLinkService,
      buildConfigService(),
      buildPgLock(884_200_937),
    );

    await cron.handleReconcile();

    expect(verifyRecordService.consumeRecord).not.toHaveBeenCalled();
  });

  it('does nothing when the advisory lock is held elsewhere', async () => {
    const { verifyRecordService, accountLinkService } = buildHarness({
      records: [
        {
          zaloUserId: 'zalo-user-1',
          userId: 143,
          verifiedAt: new Date(Date.now() - 120_000),
        },
      ],
    });
    const cron = new ZaloLinkReconcileCronService(
      verifyRecordService,
      accountLinkService,
      buildConfigService(),
      buildPgLock(0), // wrong lock ID → returns null
    );

    await cron.handleReconcile();

    expect(accountLinkService.upsertLink).not.toHaveBeenCalled();
  });

  it('does nothing when no stale records', async () => {
    const { verifyRecordService, accountLinkService } = buildHarness();
    const cron = new ZaloLinkReconcileCronService(
      verifyRecordService,
      accountLinkService,
      buildConfigService(),
      buildPgLock(884_200_937),
    );

    await cron.handleReconcile();

    expect(accountLinkService.upsertLink).not.toHaveBeenCalled();
    expect(verifyRecordService.consumeRecord).not.toHaveBeenCalled();
  });
});
