import { getRepositoryToken } from '@nestjs/typeorm';
import type { Provider } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  PlatformReportSendJobRepository,
  ReportSendJobEntity,
} from '@wispace/database';
import { REPORT_SEND_JOB_REPOSITORY } from '@wispace/scheduler-core';
import { DiscordReportModule } from './discord-report.module';

describe('Discord report persistence wiring', () => {
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
