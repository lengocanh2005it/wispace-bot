import { ZaloChatModule, ZALO_AGENT_OPTIONS } from './zalo-chat.module';
import { ZALO_OUTBOUND } from './application/ports/zalo-outbound.port';
import { ZALO_OUTBOUND_TRANSPORT } from './application/ports/zalo-outbound-transport.port';
import { ZaloOutboundService } from './application/services/zalo-outbound.service';
import { ZaloSendApiAdapter } from './infrastructure/adapters/zalo-send-api.adapter';
import { PlatformAgentService } from '@wispace/chat-agent';
import {
  RescheduleRecoveryCronService,
  TypeormRescheduleStore,
} from '@wispace/reschedule-confirm/adapters';
import { RescheduleConfirmationService } from '@wispace/reschedule-confirm/core';
import {
  PlatformReportClaimRepository,
  ReportClaimStaleResetCronService,
} from '@wispace/scheduler-core/adapters';
import { REPORT_CLAIM_REPOSITORY } from '@wispace/scheduler-core/core';
import { ZaloReportModule } from './zalo-report.module';
import {
  findEffectiveFactoryProvider,
  findFactoryProvider,
} from '@wispace/bot-common/testing';

describe('Zalo outbound port wiring', () => {
  it('binds the recovery cron to a Zalo transport so a deferred row can be replayed (#1507)', async () => {
    // Without a transport a `deferred` row has no bot that can legitimately
    // deliver it: the messenger pod would send a Zalo id to Meta, be rejected,
    // and burn all five bounded attempts.
    const binding = findEffectiveFactoryProvider(
      ZaloChatModule,
      RescheduleRecoveryCronService,
    );
    expect(binding).toBeDefined();

    const sendText = jest.fn().mockResolvedValue('sent');
    const recovery = binding!.useFactory(
      {},
      { registerCron: jest.fn() },
      {},
      {},
      { sendText },
    );

    expect(recovery).toBeInstanceOf(RescheduleRecoveryCronService);
    const notification = (
      recovery as unknown as {
        notification: { deliver: (input: unknown) => Promise<string> };
      }
    ).notification;
    await expect(
      notification.deliver({
        externalId: 'zalo-user-1',
        scheduledTimeLabel: '20/09 lúc 19:00',
        userId: 42,
      }),
    ).resolves.toBe('sent');
    // userId must reach the transport or the replay charges a second budget.
    expect(sendText).toHaveBeenCalledWith(
      'zalo-user-1',
      expect.stringContaining('20/09 lúc 19:00'),
      { userId: 42 },
    );
  });

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

  it('builds the confirmation service with the durable attempt store (#1483)', () => {
    // Without this binding no attempt record is ever created, so a replayed
    // confirmation tells the learner there is no pending request about a
    // change that committed, and the recovery cron re-arms the write.
    const attemptStore = { marker: 'attempt-store' };
    const binding = findFactoryProvider(
      ZaloChatModule,
      RescheduleConfirmationService,
    );
    expect(binding).toBeDefined();

    const service = binding!.useFactory(
      {},
      { rescheduleSession: jest.fn() },
      {},
      {},
      {},
      {},
      attemptStore,
    );

    expect(
      (service as unknown as { options: { attemptStore?: unknown } }).options
        .attemptStore,
    ).toBe(attemptStore);
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
    const binding = findEffectiveFactoryProvider(
      ZaloChatModule,
      PlatformAgentService,
    );
    expect(binding).toBeDefined();
    const dynamicBinding = findEffectiveFactoryProvider(
      ZaloChatModule,
      ZALO_AGENT_OPTIONS,
    );
    expect(dynamicBinding).toBeDefined();

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
      dynamicBinding!.useFactory(
        configService,
        metrics,
        {},
        adapter,
        {},
        {},
        {},
      ),
      null,
    );
    expect(agent).toBeInstanceOf(PlatformAgentService);
  });

  it('fails closed at startup when LLM_INPUT_CLASSIFIER_ENABLED=true with unapproved model (#864, #868)', () => {
    const dynamicBinding = findEffectiveFactoryProvider(
      ZaloChatModule,
      ZALO_AGENT_OPTIONS,
    );
    expect(dynamicBinding).toBeDefined();

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
      dynamicBinding!.useFactory(
        configService,
        {},
        {},
        { providerName: 'openai', isRateLimitError: () => false },
        {},
        {},
        {},
      ),
    ).toThrow(/not approved by LLM_ALLOWED_MODELS/i);
  });
});
