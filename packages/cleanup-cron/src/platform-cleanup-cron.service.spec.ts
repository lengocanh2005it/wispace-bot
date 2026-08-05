import { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';
import {
  CleanupCronService,
  type CleanupCronConfig,
  type CleanupResult,
} from './cleanup-cron.service';
import {
  PlatformCleanupCronService,
  type CleanupCronJobsConfig,
} from './platform-cleanup-cron.service';

type ExecuteMock = jest.Mock<
  Promise<CleanupResult | null>,
  [
    CleanupCronConfig,
    (cutoff: Date) => Promise<number>,
    () => boolean,
    () => number,
  ]
>;

function buildConfig(
  overrides: Partial<CleanupCronJobsConfig> = {},
): CleanupCronJobsConfig {
  return {
    platform: 'discord',
    envPrefix: 'DISCORD_',
    lockIds: {
      messageLog: 884_200_911,
      deadLetter: 884_200_912,
      idempotencyRecovery: 884_200_914,
      idempotencyCleanup: 884_200_915,
      ...(overrides.lockIds ?? {}),
    },
    messageLogRepo: {
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
    } as never as Repository<{ createdAt: Date }>,
    deadLetterRepo: {
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
    } as never as CleanupCronJobsConfig['deadLetterRepo'],
    idempotencyRepo: {
      createQueryBuilder: () => ({
        delete: () => ({
          from: () => ({
            where: () => ({
              andWhere: () => ({
                andWhere: () => ({
                  execute: () => Promise.resolve({ affected: 0 }),
                }),
              }),
            }),
          }),
        }),
      }),
    } as never as CleanupCronJobsConfig['idempotencyRepo'],
    oauthStateRepo: overrides.oauthStateRepo,
    rateLimitService: {
      isEnabled: jest.fn().mockReturnValue(true),
      recoverStuckReservedSlots: jest.fn().mockResolvedValue({ recovered: [] }),
    },
    ...overrides,
  };
}

function buildService(config: CleanupCronJobsConfig): {
  service: PlatformCleanupCronService;
  cleanupService: { execute: ExecuteMock };
  configService: ConfigService;
} {
  const execute = jest
    .fn<
      Promise<CleanupResult | null>,
      [
        CleanupCronConfig,
        (cutoff: Date) => Promise<number>,
        () => boolean,
        () => number,
      ]
    >()
    .mockResolvedValue({ deleted: 0, cutoff: new Date() });
  const cleanupService = { execute } as never as CleanupCronService;
  const configService = {
    get: jest.fn(() => undefined),
  } as never as ConfigService;
  const service = new PlatformCleanupCronService(
    cleanupService,
    configService,
    config,
  );
  return { service, cleanupService: { execute }, configService };
}

describe('PlatformCleanupCronService', () => {
  it('registers 4 discord crons on module init', () => {
    const { service } = buildService(buildConfig());
    service.onModuleInit();
    expect(service['jobs'].size).toBe(4);
    expect([...service['jobs'].keys()]).toEqual([
      'discord-message-log-cleanup',
      'discord-dead-letter-cleanup',
      'discord-idempotency-recovery',
      'discord-idempotency-cleanup',
    ]);
  });

  it('registers the 5th oauth-state cron for zalo', () => {
    const config = buildConfig({
      platform: 'zalo',
      envPrefix: 'ZALO_',
      lockIds: { oauthState: 884_200_913 },
      oauthStateRepo: {
        delete: jest.fn().mockResolvedValue({ affected: 0 }),
      } as never,
    });
    const { service } = buildService(config);
    service.onModuleInit();
    expect([...service['jobs'].keys()]).toContain('zalo-oauth-state-cleanup');
  });

  it('message log cleanup uses platform env keys and lock id', async () => {
    const { service, cleanupService } = buildService(buildConfig());
    await service.handleMessageLogCleanup();
    const config = cleanupService.execute.mock.calls[0][0];
    expect(config).toMatchObject({
      advisoryLockId: 884_200_911,
      enabledConfigKey: 'DISCORD_MESSAGE_LOG_CLEANUP_ENABLED',
      retentionDaysConfigKey: 'DISCORD_MESSAGE_LOG_RETENTION_DAYS',
      defaultRetentionDays: 90,
    });
  });

  it('skips idempotency recovery when rate limiting is disabled', async () => {
    const config = buildConfig();
    (config.rateLimitService.isEnabled as jest.Mock).mockReturnValue(false);
    const { service, cleanupService } = buildService(config);
    await service.handleIdempotencyRecovery();
    expect(cleanupService.execute).not.toHaveBeenCalled();
  });

  it('oauth state cleanup deletes states older than 10 minutes', async () => {
    const oauthDelete = jest.fn<
      Promise<{ affected: number }>,
      [{ createdAt: { value: Date } }]
    >();
    const oauthStateRepo = {
      delete: oauthDelete,
    } as never as Repository<{ createdAt: Date }>;
    const config = buildConfig({
      lockIds: { oauthState: 884_200_913 },
      oauthStateRepo,
    });
    const { service, cleanupService } = buildService(config);
    await service.handleOAuthStateCleanup();
    const deleteFn = cleanupService.execute.mock.calls[0][1];
    await deleteFn(new Date());
    const where = oauthDelete.mock.calls[0][0];
    expect(
      Math.abs(where.createdAt.value.getTime() - (Date.now() - 600_000)),
    ).toBeLessThan(1000);
  });
});
