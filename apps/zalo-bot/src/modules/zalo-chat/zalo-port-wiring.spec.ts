import { ZaloChatModule } from './zalo-chat.module';
import { ZALO_OUTBOUND } from './application/ports/zalo-outbound.port';
import { ZALO_OUTBOUND_TRANSPORT } from './application/ports/zalo-outbound-transport.port';
import { ZaloOutboundService } from './application/services/zalo-outbound.service';
import { ZaloSendApiAdapter } from './infrastructure/adapters/zalo-send-api.adapter';
import { PlatformAgentService } from '@wispace/chat-agent';
import {
  RescheduleRecoveryCronService,
  TypeormRescheduleStore,
} from '@wispace/reschedule-confirm/adapters';
import {
  PlatformReportClaimRepository,
  ReportClaimStaleResetCronService,
} from '@wispace/scheduler-core/adapters';
import { REPORT_CLAIM_REPOSITORY } from '@wispace/scheduler-core';
import { ZaloReportModule } from './zalo-report.module';

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

describe('Zalo outbound port wiring', () => {
  it('wires reschedule and report persistence from owner adapter entrypoints', () => {
    const rescheduleStoreBinding = findFactoryProvider(
      ZaloChatModule,
      TypeormRescheduleStore,
    );
    const rescheduleRecoveryBinding = findFactoryProvider(
      ZaloChatModule,
      RescheduleRecoveryCronService,
    );
    const reportClaimBinding = findFactoryProvider(
      ZaloReportModule,
      REPORT_CLAIM_REPOSITORY,
    );
    const reportRecoveryBinding = findFactoryProvider(
      ZaloReportModule,
      ReportClaimStaleResetCronService,
    );

    expect(rescheduleStoreBinding).toBeDefined();
    expect(rescheduleRecoveryBinding).toBeDefined();
    expect(reportClaimBinding).toBeDefined();
    expect(reportRecoveryBinding).toBeDefined();

    const rescheduleStore = rescheduleStoreBinding!.useFactory({});
    const rescheduleRecovery = rescheduleRecoveryBinding!.useFactory(
      rescheduleStore,
      { registerCron: jest.fn() },
      {},
    );
    const reportClaim = reportClaimBinding!.useFactory({}, {});
    const reportRecovery = reportRecoveryBinding!.useFactory(
      reportClaim,
      {},
      { getOutboxSettings: jest.fn() },
      { registerCron: jest.fn() },
    );

    expect(rescheduleStore).toBeInstanceOf(TypeormRescheduleStore);
    expect((rescheduleStore as { platform: string }).platform).toBe('zalo');
    expect(rescheduleRecovery).toBeInstanceOf(RescheduleRecoveryCronService);
    expect(reportClaim).toBeInstanceOf(PlatformReportClaimRepository);
    expect((reportClaim as { platform: string }).platform).toBe('zalo');
    expect(reportRecovery).toBeInstanceOf(ReportClaimStaleResetCronService);
  });

  it('registers one shared coordinator with feature-local execution ports', () => {
    const providers = (Reflect.getMetadata('providers', ZaloChatModule) ??
      []) as Array<{ provide?: unknown }>;
    expect(providers.map((provider) => provider.provide)).toEqual(
      expect.arrayContaining([
        'LLM_ADMISSION_COORDINATOR',
        'LLM_EXECUTION_PORT',
        'LLM_REPORT_EXECUTION_PORT',
      ]),
    );
  });

  it('wires the shared fail-closed policy into the startup binding', () => {
    const providers = (Reflect.getMetadata('providers', ZaloChatModule) ??
      []) as Array<unknown>;
    const binding = providers.find(
      (
        provider,
      ): provider is {
        provide: string;
        useFactory: (...args: unknown[]) => unknown;
      } =>
        typeof provider === 'object' &&
        provider !== null &&
        'provide' in provider &&
        provider.provide === 'LLM_PROVIDER_ADAPTER' &&
        'useFactory' in provider &&
        typeof provider.useFactory === 'function',
    );
    expect(binding).toBeDefined();
    expect(() =>
      binding!.useFactory(
        {
          get: (key: string) =>
            ({
              NODE_ENV: 'production',
              OPENAI_API_KEY: 'sk-test',
              OPENAI_MODEL: 'gpt-5.4',
              LLM_ALLOWED_BASE_URLS: '',
              LLM_ALLOWED_MODELS: 'openai:gpt-5.4',
            })[key],
        },
        {},
      ),
    ).toThrow(/LLM_ALLOWED_BASE_URLS.*non-empty/i);
  });

  it('binds outbound policy and transport through composition-root tokens', () => {
    const providers = (Reflect.getMetadata('providers', ZaloChatModule) ??
      []) as Array<unknown>;
    const aliases = providers.filter(
      (
        provider,
      ): provider is {
        provide: unknown;
        useExisting: unknown;
      } =>
        typeof provider === 'object' &&
        provider !== null &&
        'provide' in provider &&
        'useExisting' in provider,
    );

    expect(aliases).toEqual(
      expect.arrayContaining([
        { provide: ZALO_OUTBOUND_TRANSPORT, useExisting: ZaloSendApiAdapter },
        { provide: ZALO_OUTBOUND, useExisting: ZaloOutboundService },
      ]),
    );
  });

  it('wires PlatformAgentService with LlmContentClassifier in ZaloChatModule (#864, #868)', () => {
    const providers = (Reflect.getMetadata('providers', ZaloChatModule) ??
      []) as Array<unknown>;
    const binding = providers.find(
      (
        provider,
      ): provider is {
        provide: unknown;
        useFactory: (...args: unknown[]) => unknown;
      } =>
        typeof provider === 'object' &&
        provider !== null &&
        'provide' in provider &&
        provider.provide === PlatformAgentService &&
        'useFactory' in provider &&
        typeof provider.useFactory === 'function',
    );
    expect(binding).toBeDefined();

    const configService = {
      get: jest.fn((key: string) => {
        if (key === 'LLM_INPUT_CLASSIFIER_ENABLED') return 'true';
        if (key === 'LLM_INPUT_CLASSIFIER_MODEL')
          return 'google/gemini-2.0-flash-lite';
        if (key === 'LLM_ALLOWED_MODELS')
          return 'openai:google/gemini-2.0-flash-lite';
        return undefined;
      }),
    };
    const adapter = {
      providerName: 'openrouter',
      getDefaultModel: () => 'google/gemini-2.0-flash-lite',
      isRateLimitError: () => false,
    };
    const metrics = {
      incClassifierInput: jest.fn(),
      incClassifierVerdict: jest.fn(),
    };

    const agent = binding!.useFactory(
      configService,
      {},
      {},
      {},
      {},
      adapter,
      {},
      metrics,
      null,
      {},
      {},
      {},
      {},
    );
    expect(agent).toBeInstanceOf(PlatformAgentService);
  });

  it('fails closed at startup when LLM_INPUT_CLASSIFIER_ENABLED=true with unapproved model (#864, #868)', () => {
    const providers = (Reflect.getMetadata('providers', ZaloChatModule) ??
      []) as Array<unknown>;
    const binding = providers.find(
      (
        provider,
      ): provider is {
        provide: unknown;
        useFactory: (...args: unknown[]) => unknown;
      } =>
        typeof provider === 'object' &&
        provider !== null &&
        'provide' in provider &&
        provider.provide === PlatformAgentService &&
        'useFactory' in provider &&
        typeof provider.useFactory === 'function',
    );
    expect(binding).toBeDefined();

    const configService = {
      get: jest.fn((key: string) => {
        if (key === 'LLM_INPUT_CLASSIFIER_ENABLED') return 'true';
        if (key === 'LLM_INPUT_CLASSIFIER_MODEL') return 'unapproved-model';
        if (key === 'LLM_ALLOWED_MODELS')
          return 'openai:google/gemini-2.0-flash-lite';
        return undefined;
      }),
    };

    expect(() =>
      binding!.useFactory(
        configService,
        {},
        {},
        {},
        {},
        { providerName: 'openai', isRateLimitError: () => false },
        {},
        {},
        null,
        {},
        {},
        {},
        {},
      ),
    ).toThrow(/not approved by LLM_ALLOWED_MODELS/i);
  });
});
