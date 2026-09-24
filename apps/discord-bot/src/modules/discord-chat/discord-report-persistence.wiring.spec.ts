import { getRepositoryToken } from '@nestjs/typeorm';
import type { Provider } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  PlatformReportClaimRepository,
  PlatformReportSendJobRepository,
  ReportClaimStaleResetCronService,
} from '@wispace/scheduler-core/adapters';
import { ReportSendJobEntity } from '@wispace/database';
import {
  REPORT_CLAIM_REPOSITORY,
  REPORT_SEND_JOB_REPOSITORY,
} from '@wispace/scheduler-core';
import { DiscordReportModule } from './discord-report.module';

function findFactoryProvider(module: object, token: unknown) {
  const providers = (Reflect.getMetadata('providers', module) ??
    []) as Array<unknown>;
  return providers.find(
    (
      provider,
    ): provider is {
      provide: unknown;
      useFactory: (...args: unknown[]) => unknown;
    } =>
      typeof provider === 'object' &&
      provider !== null &&
      'provide' in provider &&
      provider.provide === token &&
      'useFactory' in provider &&
      typeof provider.useFactory === 'function',
  );
}

describe('Discord report persistence wiring', () => {
  it('resolves claim and stale-recovery adapters from the owner entrypoint', () => {
    const claimBinding = findFactoryProvider(
      DiscordReportModule,
      REPORT_CLAIM_REPOSITORY,
    );
    const recoveryBinding = findFactoryProvider(
      DiscordReportModule,
      ReportClaimStaleResetCronService,
    );

    expect(claimBinding).toBeDefined();
    expect(recoveryBinding).toBeDefined();

    const claim = claimBinding!.useFactory({}, {});
    const recovery = recoveryBinding!.useFactory(
      claim,
      {},
      { getOutboxSettings: jest.fn() },
      { registerCron: jest.fn() },
    );

    expect(claim).toBeInstanceOf(PlatformReportClaimRepository);
    expect((claim as { platform: string }).platform).toBe('discord');
    expect(recovery).toBeInstanceOf(ReportClaimStaleResetCronService);
  });

  it('resolves the platform-parameterized send-job adapter', async () => {
    const providers = (Reflect.getMetadata('providers', DiscordReportModule) ??
      []) as Array<{
      provide?: unknown;
      useFactory?: (...args: unknown[]) => unknown;
    }>;
    const binding = providers.find(
      (provider) =>
        provider.provide === REPORT_SEND_JOB_REPOSITORY &&
        typeof provider.useFactory === 'function',
    );

    expect(binding).toBeDefined();
    const moduleRef = await Test.createTestingModule({
      providers: [
        binding as Provider,
        {
          provide: getRepositoryToken(ReportSendJobEntity),
          useValue: {},
        },
      ],
    }).compile();

    const repository = moduleRef.get(REPORT_SEND_JOB_REPOSITORY);
    expect(repository).toBeInstanceOf(PlatformReportSendJobRepository);
    expect((repository as { platform: string }).platform).toBe('discord');
  });
});
