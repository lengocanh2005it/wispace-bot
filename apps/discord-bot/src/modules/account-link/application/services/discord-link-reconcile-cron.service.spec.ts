/* eslint-disable @typescript-eslint/unbound-method -- Jest mock method assertions */
import type { ConfigService } from '@nestjs/config';
import type { PgAdvisoryLockService } from '@wispace/bot-common';
import type { DiscordAccountLinkService } from './discord-account-link.service';
import type { DiscordLinkVerifyRecordRepositoryPort } from '../../domain/ports/discord-link-verify-record.repository.port';
import { DiscordLinkReconcileCronService } from './discord-link-reconcile-cron.service';

const DEFAULT_CONFIG: Record<string, string> = {
  DISCORD_LINK_RECONCILE_AGE_MS: '60000',
  DISCORD_LINK_RECONCILE_MAX_AGE_MS: '3600000',
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
    discordUserId: string;
    userId: number;
    verifiedAt: Date;
  }>;
  findUserId?: (discordUserId: string) => number | undefined;
  upsertError?: Error;
}) {
  const verifyRecordService = {
    listStaleRecords: jest.fn().mockResolvedValue(options.records ?? []),
    consumeRecord: jest.fn().mockResolvedValue(undefined),
  } as unknown as DiscordLinkVerifyRecordRepositoryPort;

  const accountLinkService = {
    findUserIdByDiscordId: jest.fn((discordUserId: string) =>
      Promise.resolve(options.findUserId?.(discordUserId)),
    ),
    upsertLink: options.upsertError
      ? jest.fn().mockRejectedValue(options.upsertError)
      : jest.fn().mockResolvedValue({ relinked: false }),
  } as unknown as DiscordAccountLinkService;

  return { verifyRecordService, accountLinkService };
}

describe('DiscordLinkReconcileCronService (#137 item 1)', () => {
  it('re-commits a missing mapping from the verify record, then consumes it', async () => {
    const { verifyRecordService, accountLinkService } = buildHarness({
      records: [
        {
          discordUserId: 'discord-user-1',
          userId: 143,
          verifiedAt: new Date(Date.now() - 120_000),
        },
      ],
    });
    const cron = new DiscordLinkReconcileCronService(
      verifyRecordService,
      accountLinkService,
      buildConfigService(),
      buildPgLock(884_200_934),
      { notify: jest.fn().mockResolvedValue(undefined) } as never,
    );

    await cron.handleReconcile();

    expect(accountLinkService.upsertLink).toHaveBeenCalledWith(
      143,
      'discord-user-1',
    );
    expect(verifyRecordService.consumeRecord).toHaveBeenCalledWith(
      'discord-user-1',
    );
  });

  it('consumes records whose mapping is already committed (leftover consume race)', async () => {
    const { verifyRecordService, accountLinkService } = buildHarness({
      records: [
        {
          discordUserId: 'discord-user-1',
          userId: 143,
          verifiedAt: new Date(Date.now() - 120_000),
        },
      ],
      findUserId: () => 143,
    });
    const cron = new DiscordLinkReconcileCronService(
      verifyRecordService,
      accountLinkService,
      buildConfigService(),
      buildPgLock(884_200_934),
      { notify: jest.fn().mockResolvedValue(undefined) } as never,
    );

    await cron.handleReconcile();

    expect(accountLinkService.upsertLink).not.toHaveBeenCalled();
    expect(verifyRecordService.consumeRecord).toHaveBeenCalledWith(
      'discord-user-1',
    );
  });

  it('drops records older than the max age when the mapping still missing', async () => {
    const { verifyRecordService, accountLinkService } = buildHarness({
      records: [
        {
          discordUserId: 'discord-user-1',
          userId: 143,
          verifiedAt: new Date(Date.now() - 2 * 3_600_000),
        },
      ],
    });
    const cron = new DiscordLinkReconcileCronService(
      verifyRecordService,
      accountLinkService,
      buildConfigService(),
      buildPgLock(884_200_934),
      { notify: jest.fn().mockResolvedValue(undefined) } as never,
    );

    await cron.handleReconcile();

    expect(accountLinkService.upsertLink).not.toHaveBeenCalled();
    expect(verifyRecordService.consumeRecord).toHaveBeenCalledWith(
      'discord-user-1',
    );
  });

  it('keeps the record when reconciliation upsert fails', async () => {
    const { verifyRecordService, accountLinkService } = buildHarness({
      records: [
        {
          discordUserId: 'discord-user-1',
          userId: 143,
          verifiedAt: new Date(Date.now() - 120_000),
        },
      ],
      upsertError: new Error('db down'),
    });
    const cron = new DiscordLinkReconcileCronService(
      verifyRecordService,
      accountLinkService,
      buildConfigService(),
      buildPgLock(884_200_934),
      { notify: jest.fn().mockResolvedValue(undefined) } as never,
    );

    await cron.handleReconcile();

    expect(verifyRecordService.consumeRecord).not.toHaveBeenCalledWith(
      'discord-user-1',
    );
  });

  it('does nothing when the advisory lock is held elsewhere', async () => {
    const { verifyRecordService, accountLinkService } = buildHarness({
      records: [
        {
          discordUserId: 'discord-user-1',
          userId: 143,
          verifiedAt: new Date(Date.now() - 120_000),
        },
      ],
    });
    const cron = new DiscordLinkReconcileCronService(
      verifyRecordService,
      accountLinkService,
      buildConfigService(),
      buildPgLock(999_999),
      { notify: jest.fn().mockResolvedValue(undefined) } as never,
    );

    await cron.handleReconcile();

    expect(verifyRecordService.listStaleRecords).not.toHaveBeenCalled();
  });

  it('#137 item 5: notifies the account when the reconciled mapping displaced another user', async () => {
    const accountLinkService = {
      findUserIdByDiscordId: jest.fn().mockResolvedValue(undefined),
      upsertLink: jest
        .fn()
        .mockResolvedValue({ relinked: true, previousUserId: 99 }),
    } as unknown as DiscordAccountLinkService;
    const relinkNotifier = {
      notify: jest.fn().mockResolvedValue(undefined),
    } as never;
    const { verifyRecordService } = buildHarness({
      records: [
        {
          discordUserId: 'discord-user-1',
          userId: 143,
          verifiedAt: new Date(Date.now() - 120_000),
        },
      ],
    });
    const cron = new DiscordLinkReconcileCronService(
      verifyRecordService,
      accountLinkService,
      buildConfigService(),
      buildPgLock(884_200_934),
      relinkNotifier,
    );

    await cron.handleReconcile();

    expect(relinkNotifier.notify).toHaveBeenCalledWith('discord-user-1', 99);
  });
});
