import { getRepositoryToken } from '@nestjs/typeorm';
import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
} from '@wispace/scheduler-core/core';
import {
  LearnerScheduledReportClaimEntity,
  MessageLogEntity,
  ScheduledReportClaimEntity,
} from '@messenger/infrastructure/database/entities';
import { MessengerOutboundModule } from './messenger-outbound.module';
import { SchedulerModule } from '../scheduler/scheduler.module';
import { MESSENGER_REPORT_SENT_READER } from './domain/repositories/messenger-report-sent-reader.port';
import { MessengerReportSentReader } from './infrastructure/persistence/messenger-report-sent-reader';

type FactoryProvider = {
  provide: unknown;
  useFactory?: (...args: unknown[]) => unknown;
};

function findFactoryProvider(
  module: object,
  token: unknown,
): FactoryProvider | undefined {
  const providers = (Reflect.getMetadata('providers', module) ?? []) as Array<
    FactoryProvider | unknown
  >;
  return providers.find(
    (provider): provider is FactoryProvider =>
      typeof provider === 'object' &&
      provider !== null &&
      'provide' in provider &&
      provider.provide === token &&
      'useFactory' in provider &&
      typeof provider.useFactory === 'function',
  );
}

describe('Messenger report persistence wiring', () => {
  it('resolves stale-claim recovery from the owner adapter entrypoint', () => {
    const binding = findFactoryProvider(
      SchedulerModule,
      ReportClaimStaleResetCronService,
    );

    expect(binding).toBeDefined();
    const recovery = binding!.useFactory?.(
      {},
      {},
      { getOutboxSettings: jest.fn() },
      { registerCron: jest.fn() },
    );

    expect(recovery).toBeInstanceOf(ReportClaimStaleResetCronService);
  });

  it('resolves the shared claim adapter at the Messenger composition root', async () => {
    const binding = findFactoryProvider(
      MessengerOutboundModule,
      REPORT_CLAIM_REPOSITORY,
    );

    expect(binding).toBeDefined();
    const moduleRef = await Test.createTestingModule({
      providers: [
        binding as Provider,
        {
          provide: getRepositoryToken(ScheduledReportClaimEntity),
          useValue: {},
        },
        {
          provide: getRepositoryToken(LearnerScheduledReportClaimEntity),
          useValue: {},
        },
      ],
    }).compile();

    const repository = moduleRef.get(REPORT_CLAIM_REPOSITORY);
    expect(repository).toBeInstanceOf(PlatformReportClaimRepository);
    expect((repository as { platform: string }).platform).toBe('messenger');
  });

  it('resolves the platform-parameterized send-job adapter', async () => {
    const binding = findFactoryProvider(
      SchedulerModule,
      REPORT_SEND_JOB_REPOSITORY,
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
    expect((repository as { platform: string }).platform).toBe('messenger');
  });

  it('resolves the sent-log reader separately from the claim adapter', async () => {
    const providers = (Reflect.getMetadata(
      'providers',
      MessengerOutboundModule,
    ) ?? []) as Array<{ provide?: unknown; useExisting?: unknown }>;
    const binding = providers.find(
      (provider) => provider.provide === MESSENGER_REPORT_SENT_READER,
    );

    expect(binding).toMatchObject({
      provide: MESSENGER_REPORT_SENT_READER,
      useExisting: MessengerReportSentReader,
    });

    const moduleRef = await Test.createTestingModule({
      providers: [
        MessengerReportSentReader,
        binding as Provider,
        {
          provide: getRepositoryToken(MessageLogEntity),
          useValue: {},
        },
        {
          provide: getRepositoryToken(LearnerScheduledReportClaimEntity),
          useValue: {},
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn() },
        },
      ],
    }).compile();

    expect(moduleRef.get(MESSENGER_REPORT_SENT_READER)).toBe(
      moduleRef.get(MessengerReportSentReader),
    );
  });
});
